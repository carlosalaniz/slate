import path from "node:path"
import YAML from "yaml"
import type { AgentSpec, PermissionRule, SkillSpec, SkillStep } from "../pack/schema.ts"
import { loadPack } from "../pack/loader.ts"
import { walkFiles, isFile, readText } from "../util/fs.ts"
import { matcher, globsMayOverlap } from "../util/glob.ts"
import type { Engine } from "./engine.ts"
import type { Ctx } from "./job.ts"
import { JobFailed, type JobContext, type LoadedPack, type ModelRef } from "./types.ts"
import { resolveRuntime } from "./vars.ts"
import { renderPrompt } from "./core-pack.ts"
import { allowedTools, waivedFor } from "./capabilities.ts"

/**
 * prepare — everything worked out before an agent starts: the job context handed to the runtime,
 * and per step the scope, permission rules, attached files and prompt.
 */

/* ------------------------------------------------------------------- job */

export function jobContext(engine: Engine, pack: LoadedPack): JobContext {
  return {
    jobId: engine.state.job.id,
    root: engine.o.root,
    pack,
    project: engine.o.project,
    tier: (t) => tier(engine, t),
    consultsDir: engine.o.paths.consults,
    dbPath: engine.o.paths.db,
    activityPath: engine.o.paths.activity,
    core: engine.core!,
    toolAccess: () => ({ registered: engine.mcpNames, shared: [...engine.sharedTools] }),
  }
}

/** low/medium/high -> a real provider model, or a fake one in tests and --dry-run. */
export function tier(engine: Engine, t: "low" | "medium" | "high"): ModelRef {
  if (engine.o.runtime.kind === "fake") return { providerID: "fake", id: `fake-${t}` }
  return { providerID: engine.o.project.provider, id: engine.o.project.models[t] }
}

/** Vars every step starts with: workspace root, run id, what is waived (scripts see SLATE_VAR_WAIVED), plus anything saved in state. */
export function baseVars(engine: Engine): Record<string, string> {
  return { workspace: engine.o.root, run: engine.state.job.id, waived: engine.o.project.capabilities.waive.join(","), ...engine.state.vars }
}

/** Loads the pack pinned in state.json by intake and saves its resolved config. */
export async function loadPinnedPack(engine: Engine): Promise<void> {
  const pinned = engine.state.job.pack
  if (!pinned) throw new JobFailed("no pack pinned for this job; run `slate start` again")
  engine.pack = await loadPack(pinned.dir, engine.o.project.config, { projectRoot: engine.o.root })
  await engine.o.state.update((s) => {
    s.config = engine.pack!.config
  })
}

/** A step's agent and skill come from the job's pack first, then from slate-core. */
export function resolveAgentAndSkill(engine: Engine, step: SkillStep): { agent?: AgentSpec; skill?: SkillSpec } {
  return {
    agent: engine.pack?.agents[step.by] ?? engine.core?.agents[step.by],
    skill: engine.pack?.skills[step.skill] ?? engine.core?.skills[step.skill],
  }
}

/* ------------------------------------------------------------------ step */

/** Step scope narrows the agent scope; never widens it. */
export async function resolveScope(engine: Engine, step: SkillStep, agent: AgentSpec, ctx: Ctx): Promise<string[]> {
  const vars = ctx.vars
  let globs: string[] | undefined
  if (step.scope?.from) globs = await scopeFromFile(resolveRuntime(step.scope.from, vars), ctx.directory)
  if (step.scope?.modify) globs = step.scope.modify.map((g) => resolveRuntime(g, vars))
  const within = step.scope?.within?.modify?.map((g) => resolveRuntime(g, vars))
  if (globs && within?.length) {
    const kept = globs.filter((g) => within.some((w) => globsMayOverlap(g, w)))
    globs = kept.length ? kept : within
  } else if (!globs && within?.length) globs = within
  const agentGlobs = (agent.scope.modify ?? []).map((g) => resolveRuntime(g, vars))
  if (!globs) return agentGlobs
  if (!agentGlobs.length) return globs
  const narrowed = globs.filter((g) => agentGlobs.some((a) => globsMayOverlap(g, a)))
  if (!narrowed.length) engine.log(`  warning: step ${step.id} scope ${globs.join(",")} is outside agent ${agent.id} scope ${agentGlobs.join(",")}; using agent scope`)
  return narrowed.length ? narrowed : agentGlobs
}

/** `stories/{story}/tasks.yaml#{task}.scope` -> tasks[].id === task -> scope.modify (plus scope.create) */
export async function scopeFromFile(ref: string, directory: string): Promise<string[] | undefined> {
  const [file, pointer] = ref.split("#")
  if (!file || !pointer) return undefined
  const abs = path.resolve(directory, file)
  if (!(await isFile(abs))) return undefined
  let doc: any
  try {
    doc = YAML.parse(await readText(abs))
  } catch {
    return undefined
  }
  const [id, ...rest] = pointer.split(".")
  const list: any[] = Array.isArray(doc) ? doc : Array.isArray(doc?.tasks) ? doc.tasks : Array.isArray(doc?.stories) ? doc.stories : []
  let node: any = list.find((t) => t?.id === id) ?? doc?.[id!]
  for (const seg of rest) node = node?.[seg]
  if (!node) return undefined
  if (Array.isArray(node)) return node.map(String)
  if (Array.isArray(node.modify) || Array.isArray(node.create)) return [...(node.modify ?? []), ...(node.create ?? [])].map(String)
  if (typeof node === "string") return [node]
  return undefined
}

/** Shell commands that only look: allowed as-is, each command of a pipeline checked on its own. */
const READ_ONLY_COMMANDS = ["cat", "head", "tail", "wc", "ls", "tree", "grep", "rg", "find", "sort", "uniq", "cut", "diff", "stat", "file", "du", "pwd", "which", "test", "echo", "git status", "git log", "git diff", "git show", "git ls-files", "git rev-parse"]

/**
 * Actions that never change anything (reading, searching, loading a skill's instructions): no agent
 * has to ask for them, in step sessions and consults alike.
 */
export const READ_ONLY_RULES: PermissionRule[] = [
  ...["read", "glob", "grep", "list", "skill"].map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
  ...readOnlyShellRules(),
]

function readOnlyShellRules(): PermissionRule[] {
  const shell = (resource: string, effect: PermissionRule["effect"]): PermissionRule => ({ action: "shell", resource, effect })
  return [
    ...READ_ONLY_COMMANDS.flatMap((c) => [shell(c, "allow"), shell(`${c} *`, "allow")]),
    // Last matching rule wins: the ways these commands can still change files go back to asking.
    ...["-exec", "-execdir", "-ok", "-delete", "-fprint"].map((flag) => shell(`find * ${flag}*`, "ask")),
    shell("*>*", "ask"),
    shell("* 2>/dev/null", "allow"),
    shell("* 2>&1", "allow"),
    shell("* >*", "ask"),
    shell("*&>*", "ask"),
  ]
}

/**
 * Edits (and shell redirects) into an agent's `scope.protect` are denied. They come after the agent's
 * own permissions, so a permissive `shell: *` or `modify: **` cannot reopen them.
 */
export function protectRules(agent: AgentSpec): PermissionRule[] {
  return (agent.scope.protect ?? []).flatMap((g): PermissionRule[] => {
    const dir = g.replace(/\*\*?$/, "")
    return [{ action: "edit", resource: g, effect: "deny" }, { action: "shell", resource: `*>*${dir}*`, effect: "deny" }]
  })
}

/**
 * MCP tools are permission actions named `<server>_<tool>`: every registered server's tools are
 * denied, then the ones this session may use are allowed again.
 */
export function toolRules(registered: string[], allowed: string[]): PermissionRule[] {
  const ns = (id: string) => `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`
  return [
    ...registered.map((id): PermissionRule => ({ action: ns(id), resource: "*", effect: "deny" })),
    ...registered.filter((id) => allowed.includes(id)).map((id): PermissionRule => ({ action: ns(id), resource: "*", effect: "allow" })),
  ]
}

/**
 * `writes` are the step's output contract: resolved for this run, editable whatever scope and
 * protect say (a task scope lists code files, not the build report the step must write).
 * `tools` are the registered MCP servers and the ones this step may call.
 */
export function permissionRules(agent: AgentSpec, scope: string[], step: SkillStep, writes: string[] = [], tools: { registered: string[]; allowed: string[] } = { registered: [], allowed: [] }): PermissionRule[] {
  // Broad rules first, specific rules last: OpenCode evaluates the ruleset with the last matching rule winning.
  const rules: PermissionRule[] = [...READ_ONLY_RULES, { action: "subagent", resource: "*", effect: "deny" }]
  rules.push({ action: "consult", resource: "*", effect: step.consult ? "allow" : "deny" })
  if (agent.role === "consultant") rules.push({ action: "edit", resource: "*", effect: "deny" }, { action: "shell", resource: "*", effect: "deny" })
  if (scope.length) {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
    for (const g of scope) rules.push({ action: "edit", resource: g, effect: "allow" })
  }
  rules.push(...agent.permissions, ...protectRules(agent))
  rules.push(...toolRules(tools.registered, tools.allowed))
  for (const w of writes) rules.push({ action: "edit", resource: w, effect: "allow" })
  for (const g of step.gates ?? []) rules.push({ action: g.on.action, resource: g.on.resource, effect: "ask" })
  return rules
}

/** Files matching the skill's `reads`, attached to the prompt (at most 40). */
export async function resolveReads(reads: string[], directory: string, vars: Record<string, string>): Promise<string[]> {
  if (!reads.length) return []
  const m = matcher(reads.map((r) => resolveRuntime(r, vars)))
  const out: string[] = []
  for (const f of await walkFiles(directory)) {
    if (m(f)) out.push(path.join(directory, f))
    if (out.length >= 40) break
  }
  return out
}

/** The step prompt: slate-core `prompts/step.md` around the skill prompt. */
export function composePrompt(engine: Engine, step: SkillStep, ctx: Ctx, skill: SkillSpec, scope: string[], vars: Record<string, string>, agent?: AgentSpec): string {
  const loops = [...ctx.untilStack].reverse()
  return renderPrompt(engine.core!, "step", {
    step: step.id,
    phase: ctx.phase,
    directory: ctx.directory,
    story: vars.story,
    task: vars.task,
    loops: loops.map((f) => `'${f.id}' round ${f.round} of ${f.max}`).join(", "),
    retried_loops: loops.filter((f) => f.round > 1).map((f) => `'${f.id}'`).join(", "),
    // The innermost retried loop is the one this step is redoing.
    last_failure: loops.find((f) => f.round > 1 && f.lastFailure)?.lastFailure?.slice(0, 1500) ?? "",
    // `**` restricts nothing, so the scope line is left out.
    scope: scope.includes("**") ? "" : scope.join(", "),
    protected: (agent?.scope.protect ?? []).join(", "),
    writes: step.writes.map((w) => resolveRuntime(w, vars)).join(", "),
    result_file: step.result ? resolveRuntime(step.result.file, vars) : "",
    result_field: step.result?.field ?? "",
    consult_agents: step.consult?.agents.join(" or ") ?? "",
    consult_max: step.consult?.max ?? "",
    tools: agent ? allowedTools(engine, agent, skill).filter((t) => engine.mcpNames.includes(t)).join(", ") : "",
    waived: agent ? waivedFor(engine, agent, skill).join(", ") : "",
    product_skills: agent?.role === "worker" ? [...engine.needSkills].map(([s, n]) => `\`${s}\` (for ${n})`).join(", ") : "",
    skill_prompt: resolveRuntime(skill.prompt, vars),
    step_prompt: step.prompt ? resolveRuntime(step.prompt, vars) : "",
  })
}
