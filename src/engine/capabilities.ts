import path from "node:path"
import YAML from "yaml"
import type { AgentSpec, CapabilitySpec, Modality, Requires, SkillSpec, Step } from "../pack/schema.ts"
import { walkSteps } from "../pack/loader.ts"
import { isFile, readText, writeText } from "../util/fs.ts"
import type { Engine } from "./engine.ts"
import { phaseIndex } from "./job.ts"
import type { LoadedPack, McpServerSpec, ModelRef, Phase, Runtime } from "./types.ts"
import type { ProjectConfig } from "../config/project.ts"
import { runScript } from "./scripts.ts"

/**
 * capabilities — what the job needs beyond a model that writes text, checked before any work.
 *
 * Agents, skills and scripts declare `requires: { tools: [...], model: { input: [...], output: [...] } }`.
 * Tools are capability ids (`capabilities/<id>.yml` in the pack or slate-core): each has a `check`
 * that costs nothing to run and, optionally, an MCP server Slate registers for the agents that
 * require it. Model modalities are read from OpenCode's model catalog. The pack's `needs` file,
 * written in discovery, maps what the product takes (sound, images, ...) to installed skills or
 * capabilities; a need nothing covers halts the job before planning.
 *
 * Anything listed in `capabilities.waive` in slate.config.yml is gone without instead: it is not
 * checked, and the agents are told it is unavailable. Model modalities are waived as
 * `<modality>-input` / `<modality>-output` (e.g. `image-input`), discovery needs by their id.
 */

export interface ModelNeed {
  who: string
  tier: "low" | "medium" | "high"
  input: Modality[]
  output: Modality[]
}

export interface Requirements {
  /** Tool id -> who needs it. */
  tools: Map<string, Set<string>>
  /** Tools an agent session calls: their MCP servers must be live. */
  sessionTools: Set<string>
  /** Tools every worker may use: capabilities and skill tools mapped from discovery needs. */
  sharedTools: Set<string>
  models: ModelNeed[]
  /** Discovery needs nothing covers (already net of waivers), and needs that name something unknown. */
  needProblems: string[]
  /** Skills named in the needs file, with the need they cover. */
  needSkills: Map<string, string>
}

export interface Need {
  id: string
  for?: string
  skill?: string
  capability?: string
}

/** Model modality waiver ids: `image-input`, `audio-output`, ... */
export function modalityId(m: Modality, dir: "input" | "output"): string {
  return `${m}-${dir}`
}

/** What the checks need: a running engine, or `slate check` without one. */
export interface CheckContext {
  root: string
  project: ProjectConfig
  runtime: Runtime
  core?: LoadedPack
  /** The phase the job is in, or would start at. */
  phase: Phase
  runId: string
}

export function checkContextOf(engine: Engine): CheckContext {
  return { root: engine.o.root, project: engine.o.project, runtime: engine.o.runtime, core: engine.core, phase: engine.state.phase, runId: engine.state.job.id }
}

export function waivedIds(project: ProjectConfig): Set<string> {
  return new Set(project.capabilities.waive)
}

export function waived(engine: Engine): Set<string> {
  return waivedIds(engine.o.project)
}

/** The model a tier runs on (fake ids under the fake runtime, as the engine does). */
function modelFor(ctx: CheckContext, t: ModelNeed["tier"]): ModelRef {
  if (ctx.runtime.kind === "fake") return { providerID: "fake", id: `fake-${t}` }
  return { providerID: ctx.project.provider, id: ctx.project.models[t] }
}

/** Everything the steps from `from` onwards require, plus what the needs file maps (once discovery wrote it). */
export async function collectRequirements(ctx: CheckContext, pack: LoadedPack, from: Phase): Promise<Requirements> {
  const req: Requirements = { tools: new Map(), sessionTools: new Set(), sharedTools: new Set(), models: [], needProblems: [], needSkills: new Map() }
  const agentOf = (id: string): AgentSpec | undefined => pack.agents[id] ?? ctx.core?.agents[id]
  const skillOf = (id: string): SkillSpec | undefined => pack.skills[id] ?? ctx.core?.skills[id]
  const addTools = (tools: string[], who: string, session: boolean) => {
    for (const t of tools) {
      if (!req.tools.has(t)) req.tools.set(t, new Set())
      req.tools.get(t)!.add(who)
      if (session) req.sessionTools.add(t)
    }
  }
  const addModel = (r: Requires[], who: string, t: ModelNeed["tier"]) => {
    const input = [...new Set(r.flatMap((x) => x.model.input))]
    const output = [...new Set(r.flatMap((x) => x.model.output))]
    if (input.length || output.length) req.models.push({ who, tier: t, input, output })
  }
  const script = (id: string, who: string) => {
    const s = pack.scripts[id]
    if (s) addTools(s.requires.tools, `script ${id} (${who})`, false)
  }
  const start = Math.max(phaseIndex(from), phaseIndex("discovery"))
  for (const { step, phase } of walkSteps(pack.manifest)) {
    if (phaseIndex(phase) < start) continue
    const where = `${phase}/${step.id}`
    visit(step, where)
  }
  function visit(step: Step, where: string) {
    if (step.type === "skill") {
      const agent = agentOf(step.by)
      const skill = skillOf(step.skill)
      if (!agent || !skill) return
      const who = `${where} (agent ${agent.id}, skill ${skill.id})`
      addTools([...agent.requires.tools, ...skill.requires.tools], who, true)
      addModel([agent.requires, skill.requires], who, step.model ?? agent.model)
      for (const c of step.consult?.agents ?? []) {
        const consultant = agentOf(c)
        if (!consultant) continue
        addTools(consultant.requires.tools, `${where} (consultant ${c})`, true)
        addModel([consultant.requires], `${where} (consultant ${c})`, consultant.model)
      }
    } else if (step.type === "script") script(step.script, where)
    else if (step.type === "loop") {
      if (step.over) script(step.over.script, where)
      if (step.until && typeof step.until === "object" && "script" in step.until) script(step.until.script, where)
    }
  }
  if (phaseIndex(ctx.phase) > phaseIndex("discovery") || phaseIndex(from) > phaseIndex("discovery")) await addNeeds(ctx, pack, req, skillOf)
  return req
}

/** The needs file: every need must name an installed skill or capability, or be waived. */
async function addNeeds(ctx: Pick<CheckContext, "root" | "project" | "core">, pack: LoadedPack, req: Requirements, skillOf: (id: string) => SkillSpec | undefined): Promise<void> {
  const rel = pack.manifest.needs
  if (!rel) return
  const skip = waivedIds(ctx.project)
  const read = await readNeeds(ctx.root, rel)
  if ("error" in read) {
    req.needProblems.push(read.error)
    return
  }
  // Workers may load any skill, so the tools a need maps to go to every worker; their models are
  // checked against every tier a worker runs on.
  const workerTiers = new Set<ModelNeed["tier"]>()
  for (const { step } of walkSteps(pack.manifest)) {
    if (step.type !== "skill") continue
    const a = pack.agents[step.by] ?? ctx.core?.agents[step.by]
    if (a?.role === "worker") workerTiers.add(step.model ?? a.model)
  }
  for (const need of read.needs) {
    if (skip.has(need.id)) continue
    const who = `need '${need.id}'${need.for ? ` (${need.for})` : ""} in ${rel}`
    if (need.skill) {
      const skill = skillOf(need.skill)
      if (!skill) {
        req.needProblems.push(`${who} names skill '${need.skill}', which is not installed.`)
        continue
      }
      req.needSkills.set(skill.id, need.id)
      for (const t of skill.requires.tools) req.sharedTools.add(t)
      const tools = skill.requires.tools
      for (const t of tools) {
        if (!req.tools.has(t)) req.tools.set(t, new Set())
        req.tools.get(t)!.add(`skill ${skill.id} for ${who}`)
        req.sessionTools.add(t)
      }
      for (const t of workerTiers) if (skill.requires.model.input.length || skill.requires.model.output.length) req.models.push({ who: `skill ${skill.id} for ${who}`, tier: t, input: skill.requires.model.input, output: skill.requires.model.output })
    } else if (need.capability) {
      if (!pack.capabilities[need.capability]) {
        req.needProblems.push(`${who} names capability '${need.capability}', which is not installed.`)
        continue
      }
      req.sharedTools.add(need.capability)
      if (!req.tools.has(need.capability)) req.tools.set(need.capability, new Set())
      req.tools.get(need.capability)!.add(who)
      req.sessionTools.add(need.capability)
    } else {
      req.needProblems.push(
        `Nothing installed covers ${who}. Add a skill that does it (e.g. ${packPath(ctx.root, pack.dir)}/skills/${need.id}.yml, with its tools under requires:) and name it as \`skill:\` for this need, or waive '${need.id}' in slate.config.yml capabilities.waive.`,
      )
    }
  }
}

/** The pack's directory as the person would type it: relative inside the project, absolute outside. */
function packPath(root: string, dir: string): string {
  const rel = path.relative(root, dir)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : dir
}

export async function readNeeds(root: string, rel: string): Promise<{ needs: Need[] } | { error: string }> {
  const file = path.join(root, rel)
  if (!(await isFile(file))) return { error: `${rel} is missing: discovery writes it to list what building the product takes (run \`slate discover\`, or write it by hand).` }
  let doc: unknown
  try {
    doc = YAML.parse(await readText(file))
  } catch (e) {
    return { error: `${rel} is not valid YAML: ${(e as Error).message}` }
  }
  const list = (doc as { needs?: unknown } | null)?.needs
  if (list === undefined || list === null) return { needs: [] }
  if (!Array.isArray(list)) return { error: `${rel}: \`needs\` must be a list` }
  const needs: Need[] = []
  for (const [i, n] of list.entries()) {
    if (!n || typeof n !== "object" || typeof (n as Need).id !== "string") return { error: `${rel}: needs[${i}] has no id` }
    const x = n as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "none" ? v.trim() : undefined)
    needs.push({ id: String(x.id), for: str(x.for), skill: str(x.skill), capability: str(x.capability) })
  }
  return { needs }
}

/**
 * Needs nothing covers, from the needs file alone (no runtime): what `slate discover` warns about
 * before `slate start` would halt on it.
 */
export async function uncoveredNeeds(ctx: Pick<CheckContext, "root" | "project" | "core">, pack: LoadedPack): Promise<string[]> {
  const req: Requirements = { tools: new Map(), sessionTools: new Set(), sharedTools: new Set(), models: [], needProblems: [], needSkills: new Map() }
  await addNeeds(ctx, pack, req, (id) => pack.skills[id] ?? ctx.core?.skills[id])
  return req.needProblems
}

/** MCP servers to register: capabilities some session needs, not waived. */
export function mcpServers(pack: LoadedPack, req: Requirements, skip: Set<string>): McpServerSpec[] {
  const out: McpServerSpec[] = []
  for (const id of [...req.sessionTools, ...req.sharedTools]) {
    const cap = pack.capabilities[id]
    if (!cap?.mcp || skip.has(id) || out.some((s) => s.name === id)) continue
    out.push({ name: id, command: cap.mcp.command, environment: cap.mcp.environment, startup: cap.mcp.startup })
  }
  return out
}

export interface PreflightResult {
  ok: boolean
  problems: string[]
  checked: string[]
  waived: string[]
}

/**
 * Runs every check the requirements call for. Nothing here spends tokens: capability checks are
 * local scripts, MCP servers are asked for their status (a handshake), model modalities come from
 * the catalog OpenCode already has.
 */
export async function preflight(ctx: CheckContext, pack: LoadedPack, req: Requirements): Promise<PreflightResult> {
  const skip = waivedIds(ctx.project)
  const problems: string[] = [...req.needProblems]
  const checked: string[] = []
  const usedWaivers = new Set<string>()
  const whoList = (s: Set<string> | undefined) => [...(s ?? [])].slice(0, 3).join("; ") + ((s?.size ?? 0) > 3 ? `; and ${s!.size - 3} more` : "")
  const fix = (cap: CapabilitySpec | undefined, id: string) => `${cap?.install ? `Fix: ${cap.install}. ` : ""}Or waive '${id}' in slate.config.yml capabilities.waive.`

  const tools = [...req.tools.keys()].filter((t) => {
    if (skip.has(t)) usedWaivers.add(t)
    return !skip.has(t)
  })
  await Promise.all(
    tools.map(async (id) => {
      const cap = pack.capabilities[id]
      if (!cap) {
        problems.push(`tool '${id}' has no capabilities/${id}.yml. Needed by ${whoList(req.tools.get(id))}.`)
        return
      }
      const r = await runScript({
        script: { id: `capability ${id}`, description: cap.description, run: cap.check, timeout: cap.timeout, timeoutMs: cap.timeoutMs, requires: { tools: [], model: { input: [], output: [] } } },
        packDir: cap.packDir,
        workspace: ctx.root,
        args: [],
        vars: { workspace: ctx.root },
        run: ctx.runId,
        // The check drives the MCP server itself, so a server that starts but cannot work fails here.
        extraEnv: cap.mcp && !skip.has(id) ? { SLATE_MCP_COMMAND: JSON.stringify(cap.mcp.command) } : undefined,
      })
      checked.push(id)
      const ok = r.ok && r.json?.ok !== false
      if (!ok) problems.push(`tool '${id}' is not available: ${r.ok ? String(r.json?.reason ?? "its check failed") : r.error}. Needed by ${whoList(req.tools.get(id))}. ${fix(cap, id)}`)
    }),
  )

  const servers = mcpServers(pack, req, skip)
  if (servers.length) {
    const timeout = Math.max(...servers.map((s) => s.startup)) * 1000
    const status = await ctx.runtime.mcpStatus(
      servers.map((s) => s.name),
      timeout,
    )
    for (const s of servers) {
      const st = status[s.name]
      checked.push(`${s.name} (mcp)`)
      if (st?.status !== "connected") problems.push(`tool '${s.name}': its MCP server (${s.command.join(" ")}) is ${st?.status ?? "missing"}${st?.error ? `: ${st.error}` : ""}. Needed by ${whoList(req.tools.get(s.name))}. ${fix(pack.capabilities[s.name], s.name)}`)
    }
  }

  const byTier = new Map<string, { input: string[]; output: string[] } | undefined>()
  for (const need of req.models) {
    const model = modelFor(ctx, need.tier)
    const name = `${model.providerID}/${model.id}`
    if (!byTier.has(name)) byTier.set(name, await ctx.runtime.modelModalities(model))
    const has = byTier.get(name)
    const missing = [...need.input.map((m) => [m, "input"] as const), ...need.output.map((m) => [m, "output"] as const)].filter(([m, dir]) => {
      const id = modalityId(m, dir)
      if (skip.has(id)) {
        usedWaivers.add(id)
        return false
      }
      return !has || !has[dir].includes(m)
    })
    for (const [m, dir] of missing) {
      const id = modalityId(m, dir)
      checked.push(`${name} ${id}`)
      problems.push(
        has
          ? `model ${name} (tier ${need.tier}) does not ${dir === "input" ? "accept" : "produce"} ${m}, which ${need.who} needs. Fix: set models.${need.tier} in slate.config.yml to a model that does, or waive '${id}'.`
          : `OpenCode does not know what model ${name} (tier ${need.tier}) accepts, and ${need.who} needs ${m} ${dir}. Fix: use a model OpenCode lists, or waive '${id}'.`,
      )
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], checked: [...new Set(checked)], waived: [...usedWaivers] }
}

/** The ids a step's agent and skill require that are waived: the step is told to do without them. */
export function waivedFor(engine: Engine, agent: AgentSpec, skill: SkillSpec): string[] {
  const skip = waived(engine)
  const ids = [...agent.requires.tools, ...skill.requires.tools, ...[agent.requires, skill.requires].flatMap((r) => [...r.model.input.map((m) => modalityId(m, "input")), ...r.model.output.map((m) => modalityId(m, "output"))])]
  return [...new Set(ids.filter((i) => skip.has(i)))]
}

/** The MCP tools a step may call: what its agent and skill require, plus what discovery needs mapped. */
export function allowedTools(engine: Engine, agent: AgentSpec, skill?: SkillSpec): string[] {
  const skip = waived(engine)
  const shared = agent.role === "worker" ? [...(engine.sharedTools ?? [])] : []
  return [...new Set([...agent.requires.tools, ...(skill?.requires.tools ?? []), ...shared])].filter((t) => !skip.has(t))
}

/**
 * `.slate/capabilities.md`: the installed skills and tools, so discovery can map what the product
 * needs to what exists (and say plainly when nothing does).
 */
export async function writeCatalog(root: string, pack: LoadedPack, core?: LoadedPack): Promise<string> {
  const skills = { ...(core?.skills ?? {}), ...pack.skills }
  const lines = ["# Installed skills and tools", "", "## Skills", ""]
  for (const s of Object.values(skills).sort((a, b) => a.id.localeCompare(b.id))) {
    const tools = s.requires.tools.length ? ` (tools: ${s.requires.tools.join(", ")})` : ""
    lines.push(`- \`${s.id}\`: ${s.description || "(no description)"}${tools}`)
  }
  lines.push("", "## Tools (capabilities)", "")
  for (const c of Object.values(pack.capabilities).sort((a, b) => a.id.localeCompare(b.id))) lines.push(`- \`${c.id}\`: ${c.description || "(no description)"}`)
  const file = path.join(root, ".slate", "capabilities.md")
  await writeText(file, lines.join("\n") + "\n")
  return file
}

