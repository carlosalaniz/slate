import path from "node:path"
import YAML from "yaml"
import { isDir, isFile, listDir, readText } from "../util/fs.ts"
import { parseDuration } from "../util/time.ts"
import {
  ManifestSchema,
  AgentFileSchema,
  SkillFileSchema,
  ScriptFileSchema,
  CapabilityFileSchema,
  ExhaustedSimple,
  type Manifest,
  type Step,
  type AgentSpec,
  type SkillSpec,
  type ScriptSpec,
  type CapabilitySpec,
  type LoopStep,
  type ExhaustedPolicy,
  PHASES,
} from "./schema.ts"
import type { LoadedPack } from "../engine/types.ts"
import { resolveConfigValue } from "../engine/vars.ts"
import { listVars } from "../engine/vars.ts"
import { bundledPacksDir } from "../config/paths.ts"

export class PackError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"))
    this.name = "PackError"
  }
}

async function readYamlDir<T>(dir: string, parse: (raw: unknown, id: string) => T, problems: string[]): Promise<Record<string, T>> {
  const out: Record<string, T> = {}
  if (!(await isDir(dir))) return out
  for (const name of await listDir(dir)) {
    if (!/\.ya?ml$/.test(name)) continue
    const id = name.replace(/\.ya?ml$/, "")
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      problems.push(`${path.basename(dir)}/${name}: filename must be a kebab-case id`)
      continue
    }
    let raw: unknown
    try {
      raw = YAML.parse(await readText(path.join(dir, name))) ?? {}
    } catch (e) {
      problems.push(`${path.basename(dir)}/${name}: invalid YAML: ${(e as Error).message}`)
      continue
    }
    if (raw && typeof raw === "object" && "id" in (raw as object)) problems.push(`${path.basename(dir)}/${name}: do not set 'id' inside the file; the filename is the id`)
    try {
      out[id] = parse(raw, id)
    } catch (e) {
      problems.push(`${path.basename(dir)}/${name}: ${formatZod(e)}`)
    }
  }
  return out
}

function formatZod(e: unknown): string {
  const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues
  if (issues) return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
  return (e as Error).message
}

/** Walks every step in every phase, depth first, with the enclosing loop chain (parallel lanes are walked through). */
export function* walkSteps(manifest: Manifest): Generator<{ step: Step; phase: (typeof PHASES)[number]; parents: LoopStep[] }> {
  function* walk(steps: Step[], phase: (typeof PHASES)[number], parents: LoopStep[]): Generator<{ step: Step; phase: (typeof PHASES)[number]; parents: LoopStep[] }> {
    for (const step of steps) {
      yield { step, phase, parents }
      if (step.type === "loop") yield* walk(step.steps, phase, [...parents, step])
      else if (step.type === "parallel") yield* walk(step.steps, phase, parents)
    }
  }
  for (const phase of PHASES) yield* walk(manifest.phases[phase], phase, [])
}

/** Validates ids and every cross reference. Returns problems; empty means valid. */
export function validatePack(
  manifest: Manifest,
  agents: Record<string, AgentSpec>,
  skills: Record<string, SkillSpec>,
  scripts: Record<string, ScriptSpec>,
  capabilities: Record<string, CapabilitySpec> = {},
): string[] {
  const problems: string[] = []
  const ids = new Map<string, string>()
  const all = [...walkSteps(manifest)]
  for (const { step, phase } of all) {
    const prev = ids.get(step.id)
    if (prev) problems.push(`step id '${step.id}' is used twice (${prev} and ${phase})`)
    ids.set(step.id, phase)
  }
  for (const { step, phase } of all) {
    const where = `${phase}/${step.id}`
    if (step.type === "skill") {
      if (!skills[step.skill]) problems.push(`${where}: unknown skill '${step.skill}'`)
      const agent = agents[step.by]
      if (!agent) problems.push(`${where}: unknown agent '${step.by}'`)
      else if (agent.role !== "worker") problems.push(`${where}: agent '${step.by}' has role ${agent.role}; only workers run skill steps`)
      for (const c of step.consult?.agents ?? []) {
        const a = agents[c]
        if (!a) problems.push(`${where}: consult references unknown agent '${c}'`)
        else if (a.role === "reviewer") problems.push(`${where}: '${c}' is a reviewer; reviewers cannot be consulted (use a consultant or worker)`)
      }
      for (const g of step.gates ?? []) {
        for (const r of g.review) {
          const a = agents[r]
          if (!a) problems.push(`${where}: gate reviewer '${r}' is not a known agent`)
          else if (a.role === "consultant") problems.push(`${where}: gate reviewer '${r}' is a consultant; reviewers run without a session`)
        }
      }
      if (step.result && !step.writes.some((w) => w === step.result?.file)) {
        problems.push(`${where}: result.file '${step.result.file}' should also be listed in writes`)
      }
    } else if (step.type === "script") {
      if (!scripts[step.script]) problems.push(`${where}: unknown script '${step.script}'`)
    } else if (step.type === "loop") {
      if (step.over && !scripts[step.over.script]) problems.push(`${where}: over.script '${step.over.script}' is not a known script`)
      if (typeof step.until === "object" && "script" in step.until && !scripts[step.until.script]) problems.push(`${where}: until.script '${step.until.script}' is not a known script`)
      if (typeof step.until === "object" && "result" in step.until) {
        const target = findStep(step.steps, step.until.result)
        if (!target) problems.push(`${where}: until.result '${step.until.result}' is not a step inside this loop`)
        else if (target.type !== "skill" || !target.result) problems.push(`${where}: until.result '${step.until.result}' must be a skill step that declares result`)
      }
      if (typeof step.max === "number" && step.max < 1) problems.push(`${where}: max must be at least 1`)
    }
  }
  const lead = manifest.discovery.lead
  if (lead && !agents[lead]) problems.push(`discovery.lead: unknown agent '${lead}'`)
  else if (lead && agents[lead]!.role !== "worker") problems.push(`discovery.lead: agent '${lead}' has role ${agents[lead]!.role}; the discovery lead must be a worker`)
  for (const [id, a] of Object.entries(agents)) {
    if (a.role === "consultant" && (a.scope.modify?.length ?? 0) > 0) problems.push(`agents/${id}: consultants cannot declare scope.modify`)
  }
  const known = Object.keys(capabilities)
  const checkTools = (where: string, tools: string[]) => {
    for (const t of tools) if (!capabilities[t]) problems.push(`${where}: requires unknown tool '${t}' (known: ${known.join(", ") || "none"}; add capabilities/${t}.yml)`)
  }
  for (const [id, a] of Object.entries(agents)) checkTools(`agents/${id}`, a.requires.tools)
  for (const [id, sk] of Object.entries(skills)) checkTools(`skills/${id}`, sk.requires.tools)
  for (const [id, sc] of Object.entries(scripts)) {
    checkTools(`scripts/${id}`, sc.requires.tools)
    if (sc.requires.model.input.length || sc.requires.model.output.length) problems.push(`scripts/${id}: a script runs no model; requires.model does not apply`)
  }
  return problems
}

/** `scripts/` (and `capabilities/`) hold only the `.yml` descriptions; the code goes in `<dir>/scripts/`. */
async function checkScriptsLayout(dir: string): Promise<string[]> {
  if (!(await isDir(dir))) return []
  const problems: string[] = []
  const base = path.basename(dir)
  for (const name of await listDir(dir)) {
    if (/\.ya?ml$/.test(name) || name === "scripts" || name.startsWith(".")) continue
    problems.push(`${base}/${name}: only .yml files belong in ${base}/; put script code in ${base}/scripts/`)
  }
  return problems
}

/** A pack's `capabilities/`; `$SLATE_PACK` in their checks is that pack's directory. */
async function readCapabilities(packDir: string, problems: string[]): Promise<Record<string, CapabilitySpec>> {
  const dir = path.join(packDir, "capabilities")
  problems.push(...(await checkScriptsLayout(dir)))
  return readYamlDir(
    dir,
    (raw, id): CapabilitySpec => {
      const f = CapabilityFileSchema.parse(raw)
      return { id, ...f, packDir: path.resolve(packDir), timeoutMs: parseDuration(f.timeout, 60_000) }
    },
    problems,
  )
}

/** slate-core's capabilities are available to every pack; a pack's own file with the same id wins. */
async function coreCapabilities(packDir: string): Promise<Record<string, CapabilitySpec>> {
  const core = path.join(bundledPacksDir(), "slate-core")
  if (path.resolve(packDir) === path.resolve(core)) return {}
  const problems: string[] = []
  const caps = await readCapabilities(core, problems)
  if (problems.length) throw new PackError(problems.map((p) => `slate-core ${p}`))
  return caps
}

export function findStep(steps: Step[], id: string): Step | undefined {
  for (const s of steps) {
    if (s.id === id) return s
    if (s.type === "loop" || s.type === "parallel") {
      const f = findStep(s.steps, id)
      if (f) return f
    }
  }
  return undefined
}

/** Resolves every `${config}` placeholder in the manifest in place, returning a new manifest. */
export function resolveManifest(manifest: Manifest, config: Record<string, unknown>): Manifest {
  function policy(p: ExhaustedPolicy | undefined, where: string): ExhaustedPolicy | undefined {
    if (p === undefined) return undefined
    const v = resolveConfigValue<string>(p, config, where)
    const parsed = ExhaustedSimple.safeParse(v)
    if (!parsed.success) throw new PackError([`${where}: on_exhausted must be ask-human|ask-decision-agent|fail, got ${JSON.stringify(v)}`])
    return parsed.data
  }
  function num(v: number | string, where: string): number {
    const r = resolveConfigValue<unknown>(v, config, where)
    const n = typeof r === "number" ? r : Number(r)
    if (!Number.isInteger(n) || n < 0) throw new PackError([`${where}: expected a non-negative integer, got ${JSON.stringify(r)}`])
    return n
  }
  /** Script arguments may carry config too (`args: ["${ux_passes}"]`); they stay strings. */
  function args(list: string[], where: string): string[] {
    return list.map((a) => String(resolveConfigValue<unknown>(a, config, where)))
  }
  function steps(list: Step[], phase: string): Step[] {
    return list.map((s) => {
      if (s.type === "parallel") return { ...s, steps: steps(s.steps, phase) }
      if (s.type === "script") return { ...s, args: args(s.args, `${phase}/${s.id}.args`) }
      if (s.type !== "loop") return s
      const where = `${phase}/${s.id}`
      const until = s.until && typeof s.until === "object" && "script" in s.until ? { ...s.until, args: args(s.until.args, `${where}.until.args`) } : s.until
      return {
        ...s,
        over: s.over ? { ...s.over, args: args(s.over.args, `${where}.over.args`) } : undefined,
        until,
        max: num(s.max, `${where}.max`),
        concurrency: s.concurrency === undefined ? undefined : num(s.concurrency, `${where}.concurrency`),
        on_exhausted: policy(s.on_exhausted, `${where}.on_exhausted`),
        steps: steps(s.steps, phase),
      }
    })
  }
  return {
    ...manifest,
    phases: {
      discovery: steps(manifest.phases.discovery, "discovery"),
      plan: steps(manifest.phases.plan, "plan"),
      build: steps(manifest.phases.build, "build"),
      close: steps(manifest.phases.close, "close"),
    },
  }
}

export async function loadPack(dir: string, overrides: Record<string, unknown> = {}): Promise<LoadedPack> {
  const problems: string[] = []
  const manifestPath = path.join(dir, "slate-pack.yml")
  if (!(await isFile(manifestPath))) throw new PackError([`${dir}: slate-pack.yml not found`])
  let rawManifest: unknown
  try {
    rawManifest = YAML.parse(await readText(manifestPath))
  } catch (e) {
    throw new PackError([`slate-pack.yml: invalid YAML: ${(e as Error).message}`])
  }
  const parsed = ManifestSchema.safeParse(rawManifest)
  if (!parsed.success) throw new PackError([`slate-pack.yml: ${formatZod(parsed.error)}`])
  const manifest = parsed.data

  const agents = await readYamlDir(path.join(dir, "agents"), (raw, id): AgentSpec => ({ id, ...AgentFileSchema.parse(raw) }), problems)
  const skills = await readYamlDir(path.join(dir, "skills"), (raw, id): SkillSpec => ({ id, ...SkillFileSchema.parse(raw) }), problems)
  problems.push(...(await checkScriptsLayout(path.join(dir, "scripts"))))
  const scripts = await readYamlDir(
    path.join(dir, "scripts"),
    (raw, id): ScriptSpec => {
      const f = ScriptFileSchema.parse(raw)
      return { id, ...f, timeoutMs: parseDuration(f.timeout, 30_000) }
    },
    problems,
  )
  const capabilities = { ...(await coreCapabilities(dir)), ...(await readCapabilities(dir, problems)) }
  problems.push(...validatePack(manifest, agents, skills, scripts, capabilities))
  // Skill prompts may only use runtime vars we know how to provide.
  for (const s of Object.values(skills)) {
    for (const v of listVars(s.prompt + "\n" + s.reads.join("\n"))) {
      if (!/^(story|task|round|round\.[a-z0-9-]+|workspace|run|step|[a-zA-Z_][a-zA-Z0-9_]*)$/.test(v)) problems.push(`skills/${s.id}: bad variable {${v}}`)
    }
  }
  if (problems.length) throw new PackError(problems)
  const config = { ...manifest.config, ...overrides }
  let resolved: Manifest
  try {
    resolved = resolveManifest(manifest, config)
  } catch (e) {
    if (e instanceof PackError) throw e
    throw new PackError([(e as Error).message])
  }
  return { dir: path.resolve(dir), manifest: resolved, agents, skills, scripts, capabilities, config }
}
