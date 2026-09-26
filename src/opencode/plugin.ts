import path from "node:path"
import { z } from "zod"
import type { AgentSpec, SkillSpec, PermissionRule } from "../pack/schema.ts"
import type { CorePack, JobContext, ModelRef } from "../engine/types.ts"
import { matchesAny } from "../util/glob.ts"
import { writeText, isFile, walkFiles } from "../util/fs.ts"
import { matcher } from "../util/glob.ts"
import { parseFrontmatter, stringifyFrontmatter } from "../util/frontmatter.ts"
import { renderMessage, renderPrompt } from "../engine/core-pack.ts"
import type { SessionRegistry, SessionEntry } from "./registry.ts"
import { toolError } from "./activity.ts"
import { READ_ONLY_RULES, protectRules, toolRules } from "../engine/prepare.ts"

/**
 * The Slate plugin: everything that only code inside OpenCode can do.
 *  - registers pack agents and skills through the v2 transforms
 *  - adds the `consult` tool (bounded, logged child sessions; depth one)
 *  - evaluates gates in the permission hook, running reviewers as transient generations
 *  - applies the infra retry policy and mirrors tool results into the audit log
 * Text the model reads (consult framing, the consult tool description, the gate answer format)
 * comes from slate-core `prompts/`.
 */
export interface PluginHost {
  job: JobContext
  registry: SessionRegistry
  tier(t: "low" | "medium" | "high"): ModelRef
  log(line: string): void
}

const CONSULTANT_RULES: PermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "write", resource: "*", effect: "deny" },
  { action: "patch", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "consult", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
]

/** `tools`: registered MCP servers and those every worker may use; the agent's own `requires.tools` are allowed too. */
export function agentPermissionRules(agent: AgentSpec, tools: { registered: string[]; shared: string[] } = { registered: [], shared: [] }): PermissionRule[] {
  const rules: PermissionRule[] = [...READ_ONLY_RULES, { action: "subagent", resource: "*", effect: "deny" }]
  if (agent.role === "consultant") rules.push(...CONSULTANT_RULES)
  const modify = agent.scope.modify ?? []
  if (modify.length) {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
    for (const g of modify) rules.push({ action: "edit", resource: g, effect: "allow" })
  }
  rules.push(...agent.permissions, ...protectRules(agent))
  rules.push(...toolRules(tools.registered, [...agent.requires.tools, ...(agent.role === "worker" ? tools.shared : [])]))
  return rules
}

export function allAgents(job: JobContext): Record<string, AgentSpec> {
  return { ...job.core.agents, ...job.pack.agents }
}

export function allSkills(job: JobContext): Record<string, SkillSpec> {
  return { ...job.core.skills, ...job.pack.skills }
}

/** The consult tool's description and argument help, from slate-core `prompts/consult-tool.md`. */
export function consultToolText(core: CorePack): { description: string; agent: string; question: string } {
  const { data, body } = parseFrontmatter(core.prompts["consult-tool"] ?? "")
  const d = (data ?? {}) as Record<string, unknown>
  return { description: body.trim(), agent: String(d.agent ?? ""), question: String(d.question ?? "") }
}

export async function writeSkillFiles(job: JobContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const s of Object.values(allSkills(job))) {
    const p = path.join(job.root, ".slate", "skills", s.id, "SKILL.md")
    const content = stringifyFrontmatter({ name: s.id, description: s.description }, `\n${s.prompt}\n`)
    if (!(await isFile(p))) await writeText(p, content)
    else await writeText(p, content)
    out[s.id] = p
  }
  return out
}

export function createSlatePlugin(host: PluginHost) {
  const { job, registry } = host
  return {
    id: "slate",
    async setup(ctx: any) {
      const regs: { dispose: () => Promise<void> }[] = []
      const agents = allAgents(job)
      const skillPaths = await writeSkillFiles(job)

      regs.push(
        await ctx.agent.transform((editor: any) => {
          for (const a of Object.values(agents)) {
            if (a.role === "reviewer") continue
            editor.update(a.id, (def: any) => {
              def.description = a.description
              def.mode = a.role === "consultant" ? "subagent" : "primary"
              def.model = host.tier(a.model)
              def.system = a.prompt
              def.hidden = false
              if (a.role === "consultant") def.steps = a.steps ?? 8
              else if (a.steps) def.steps = a.steps
              def.permissions = agentPermissionRules(a, job.toolAccess())
            })
          }
        }),
      )

      regs.push(
        await ctx.skill.transform((editor: any) => {
          for (const s of Object.values(allSkills(job))) {
            const existing = editor.get(s.id)
            const info = { id: s.id, name: s.id, description: s.description, path: skillPaths[s.id], content: s.prompt }
            if (existing) editor.update(s.id, (def: any) => Object.assign(def, info))
            else editor.add(info)
          }
        }),
      )

      const consultText = consultToolText(job.core)
      regs.push(
        await ctx.tool.transform((editor: any) => {
          editor.add({
            name: "consult",
            description: consultText.description,
            input: z.object({
              agent: z.string().describe(consultText.agent),
              question: z.string().describe(consultText.question),
            }),
            async execute(input: { agent: string; question: string }, context: any) {
              return consult(ctx, host, input, context)
            },
          })
        }),
      )

      regs.push(
        await ctx.permission.hook("evaluate", async (ev: any) => {
          const entry = registry.get(ev.sessionID)
          if (!entry || ev.effect === "deny") return
          await evaluateGates(ctx, host, entry, ev)
        }),
      )

      regs.push(
        await ctx.session.hook("retry", (ev: any) => {
          const entry = registry.get(ev.sessionID)
          const status: number | undefined = ev.error?.status
          const type: string = ev.error?.type ?? ""
          const message: string = ev.error?.message ?? ""
          const transient = status === 429 || (status !== undefined && status >= 500) || /rate.?limit|overloaded|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(type + " " + message)
          if (transient && ev.attempt <= 6) {
            const delay = Math.min(60_000, 1000 * 2 ** ev.attempt) + Math.floor(Math.random() * 500)
            ev.decision = { retry: true, delay }
            entry?.onAudit?.({ type: "infra.retry", key: entry.key, step: entry.stepId, attempt: ev.attempt, error: `${type}: ${message}`.slice(0, 300) })
          }
        }),
      )

      regs.push(
        await ctx.tool.hook("execute.after", (ev: any) => {
          const entry = registry.get(ev.sessionID)
          if (!entry) return
          // Not a system notice: the live view already shows the failure on the agent's line.
          if (ev.status === "error") host.log(`  ${entry.key}: tool ${ev.tool} failed: ${toolError(ev.error?.message)}`)
        }),
      )

      return async () => {
        for (const r of regs) await r.dispose()
      }
    },
  }
}

async function consult(ctx: any, host: PluginHost, input: { agent: string; question: string }, context: any) {
  const { registry, job } = host
  const parent = registry.get(context.sessionID)
  const fail = (message: string) => {
    const err = new Error(message) as Error & { _tag?: string }
    err.name = "ToolError"
    throw err
  }
  const say = (key: string, vars: Record<string, string | number> = {}) => renderMessage(job.core, key, vars)
  if (!parent) return fail(say("consult-unavailable"))
  if (parent.role === "consultant") return fail(say("consult-from-consultant"))
  if (!parent.consult) return fail(say("consult-not-allowed"))
  if (!parent.consult.agents.includes(input.agent)) return fail(say("consult-wrong-agent", { agents: parent.consult.agents.join(", ") }))
  if (parent.consultsMade >= parent.consult.max) return fail(say("consult-limit", { max: parent.consult.max }))
  const consultant = allAgents(job)[input.agent]
  if (!consultant) return fail(say("consult-unknown-agent", { agent: input.agent }))
  parent.consultsMade += 1
  const n = parent.consultsMade
  const reads = consultant.scope.read ?? []
  const files: string[] = []
  if (reads.length) {
    const all = await walkFiles(parent.directory)
    const m = matcher(reads)
    for (const f of all) if (m(f) && files.length < 30) files.push(path.join(parent.directory, f))
  }
  const child = await ctx.session.create({
    location: { directory: parent.directory },
    agent: consultant.id,
    model: host.tier(consultant.model),
    title: `consult ${consultant.id} for ${parent.stepId} #${n}`,
    metadata: { slateJob: job.jobId, slateConsult: true, slateParent: parent.sessionID, slateStep: parent.stepId },
    permissions: agentPermissionRules(consultant, job.toolAccess()),
  })
  parent.children.push(child.id)
  registry.set({
    sessionID: child.id,
    key: `${parent.key}/consult#${n}`,
    stepId: parent.stepId,
    phase: parent.phase,
    agent: consultant,
    directory: parent.directory,
    vars: parent.vars,
    consultsMade: 0,
    children: [],
    gates: [],
    role: "consultant",
    parent: parent.sessionID,
    reviewerNotes: [],
    onAudit: parent.onAudit,
  })
  const text = renderPrompt(job.core, "consult", { parent_agent: parent.agent.id, step: parent.stepId, question: input.question })
  await ctx.session.prompt({ sessionID: child.id, text, files: files.map((f) => ({ uri: "file://" + f })) })
  await ctx.session.wait({ sessionID: child.id })
  let answer = await lastAssistantText(ctx, child.id)
  let verdict = parseVerdictLine(answer)
  if (!verdict) {
    await ctx.session.prompt({ sessionID: child.id, text: renderPrompt(job.core, "consult-verdict", {}) })
    await ctx.session.wait({ sessionID: child.id })
    answer = await lastAssistantText(ctx, child.id)
    verdict = parseVerdictLine(answer) ?? "none"
  }
  const file = path.join(job.consultsDir, parent.stepId, `${n}.md`)
  await writeText(
    file,
    stringifyFrontmatter(
      { step: parent.stepId, key: parent.key, consultant: consultant.id, asked_by: parent.agent.id, n, verdict, session: child.id },
      `\n## Question\n\n${input.question}\n\n## Answer\n\n${answer}\n`,
    ),
  )
  parent.onAudit?.({ type: "consult", key: parent.key, step: parent.stepId, consultant: consultant.id, n, verdict, file: path.relative(job.root, file), sessionID: child.id })
  return { output: { answer, verdict, file: path.relative(job.root, file) }, content: say("consult-result", { answer, verdict, n, max: parent.consult.max }) }
}

export async function lastAssistantText(ctx: any, sessionID: string): Promise<string> {
  const messages: any[] = await ctx.session.context({ sessionID })
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== "assistant") continue
    const parts = (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text)
    if (parts.length) return parts.join("\n").trim()
  }
  return ""
}

export function parseVerdictLine(text: string): string | undefined {
  const m = /^\s*verdict\s*:\s*([a-zA-Z_-]+)\s*$/im.exec(text)
  return m?.[1]?.toLowerCase()
}

export interface ReviewerVerdict {
  decision: "approve" | "reject" | "escalate"
  cite?: string
  note?: string
}

export function parseReviewerVerdict(text: string): ReviewerVerdict {
  const d = /^\s*decision\s*:\s*(approve|reject|escalate)/im.exec(text)?.[1]?.toLowerCase() as ReviewerVerdict["decision"] | undefined
  const cite = /^\s*cite\s*:\s*(.+)$/im.exec(text)?.[1]?.trim()
  const note = /^\s*note\s*:\s*(.+)$/im.exec(text)?.[1]?.trim()
  return { decision: d ?? "escalate", cite, note: note ?? (d ? undefined : text.slice(0, 300)) }
}

/** The gate reviewer's prompt, from slate-core `prompts/gate-review.md`. */
export function reviewerPrompt(core: CorePack, reviewer: AgentSpec, action: string, resources: string[], inputs: { path: string; content: string }[]): string {
  return renderPrompt(core, "gate-review", {
    reviewer_prompt: reviewer.prompt,
    action,
    resources: resources.join(", "),
    inputs: inputs.map((i) => `=== ${i.path} ===\n${i.content.slice(0, 12000)}`).join("\n"),
  })
}

async function evaluateGates(ctx: any, host: PluginHost, entry: SessionEntry, ev: any) {
  const resources: string[] = ev.resources ?? []
  const say = (key: string, vars: Record<string, string> = {}) => renderMessage(host.job.core, key, { action: ev.action, resources: resources.join(" "), ...vars })
  for (const gate of entry.gates) {
    const actionMatches = gate.on.action === "*" || gate.on.action === ev.action
    if (!actionMatches) continue
    const resourceMatches = resources.length === 0 ? gate.on.resource === "*" : resources.some((r) => matchesAny(r, [gate.on.resource]))
    if (!resourceMatches) continue
    const reviewers = gate.review.map((id) => allAgents(host.job)[id]).filter((a): a is AgentSpec => !!a)
    if (reviewers.length === 0) {
      ev.effect = "ask"
      ev.message = say("gate-ask")
      entry.reviewerNotes = ["no reviewers configured; straight to a human"]
      entry.onAudit?.({ type: "gate", key: entry.key, step: entry.stepId, action: ev.action, resource: resources.join(" "), decision: "ask", reviewers: [] })
      return
    }
    const inputs: { path: string; content: string }[] = []
    for (const rel of gate.inputs) {
      const resolved = rel.replace(/\{([a-zA-Z_.-]+)\}/g, (w, k: string) => entry.vars[k] ?? w)
      const abs = path.resolve(entry.directory, resolved)
      if (await isFile(abs)) inputs.push({ path: resolved, content: await Bun.file(abs).text() })
      else inputs.push({ path: resolved, content: say("gate-input-missing") })
    }
    const results: { id: string; decision: string; note?: string }[] = []
    let anyReject = false
    let anyEscalate = false
    for (const r of reviewers) {
      let verdict: ReviewerVerdict
      try {
        const out = await ctx.generate.text({ prompt: reviewerPrompt(host.job.core, r, ev.action, resources, inputs), model: host.tier(r.model) })
        verdict = parseReviewerVerdict(out?.text ?? "")
      } catch (e) {
        verdict = { decision: "escalate", note: `reviewer error: ${(e as Error).message}` }
      }
      if (verdict.decision === "approve" && !verdict.cite) verdict = { ...verdict, decision: "escalate", note: `${verdict.note ?? ""} (no citation)`.trim() }
      results.push({ id: r.id, decision: verdict.decision, note: verdict.note })
      if (verdict.decision === "reject") anyReject = true
      if (verdict.decision === "escalate") anyEscalate = true
    }
    const decision: "allow" | "deny" | "ask" = anyReject ? "deny" : anyEscalate ? (gate.else === "deny" ? "deny" : "ask") : "allow"
    ev.effect = decision
    const notes = results.map((r) => `${r.id}: ${r.decision}${r.note ? ` (${r.note})` : ""}`)
    if (decision === "deny") ev.message = say("gate-rejected", { notes: notes.join("; ") })
    if (decision === "ask") ev.message = say("gate-escalated", { notes: notes.join("; ") })
    entry.reviewerNotes = notes
    entry.onAudit?.({ type: "gate", key: entry.key, step: entry.stepId, action: ev.action, resource: resources.join(" "), decision, reviewers: results })
    return
  }
}
