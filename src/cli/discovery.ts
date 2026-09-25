import path from "node:path"
import YAML from "yaml"
import type { ProjectConfig } from "../config/project.ts"
import type { ProjectPaths } from "../config/paths.ts"
import type { AgentSpec, Step } from "../pack/schema.ts"
import { loadPack } from "../pack/loader.ts"
import { listInstalledPacks, findPack, type InstalledPack } from "../pack/registry.ts"
import { loadCorePack, renderPrompt } from "../engine/core-pack.ts"
import type { CorePack } from "../engine/types.ts"
import { isFile, readTextOr, writeJsonAtomic, writeText } from "../util/fs.ts"
import { CliError } from "./output.ts"

/**
 * Discovery is a live conversation in the user's own OpenCode. Slate writes agents into the
 * project's `.opencode/agents/`: its discovery lead (primary; asks with the `question` tool, may
 * only write the brief) and one subagent per pack agent that drafts a discovery document. It
 * creates a session for the lead through the OpenCode service, then opens the OpenCode app on it
 * with the first message, so the lead starts the interview. While the app is open, Slate watches
 * the brief: once it names a pack, the pack's discovery documents are created as placeholders.
 * Discovery is done when the brief names an installed pack and every document is written.
 */

export const DISCOVERY_AGENT = "slate-discovery"
/** First line of a placeholder document; a document that still has it counts as missing. */
export const PLACEHOLDER_MARKER = "<!-- slate: discovery placeholder -->"

export interface DiscoveryRecord {
  /** OpenCode session holding the conversation. */
  session?: string
  startedAt?: string
  /** Set once the outputs check passes: the chosen pack as name@version. */
  pack?: string
  completedAt?: string
  /** The job that consumed this discovery; the next job needs a new one. */
  job?: string
}

export interface DiscoveryCheck {
  done: boolean
  pack?: InstalledPack
  /** Human-readable list of what is still missing. */
  missing: string[]
}

export interface DiscoveryDoc {
  file: string
  instructions: string
  /** Pack agent that drafts it (the step's `by`). */
  agent: AgentSpec
}

export async function readDiscovery(paths: ProjectPaths): Promise<DiscoveryRecord> {
  try {
    return JSON.parse(await readTextOr(paths.discovery, "{}")) as DiscoveryRecord
  } catch {
    return {}
  }
}

export async function writeDiscovery(paths: ProjectPaths, record: DiscoveryRecord): Promise<void> {
  await writeJsonAtomic(paths.discovery, record)
}

/** Discovery documents a pack asks for: the files written by skill steps in its discovery phase. */
export async function discoveryDocs(pack: InstalledPack): Promise<DiscoveryDoc[]> {
  const loaded = await loadPack(pack.dir)
  const docs: DiscoveryDoc[] = []
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      if (s.type === "loop") walk(s.steps)
      else if (s.type === "skill" && s.writes?.length) {
        const skill = loaded.skills[s.skill]
        const agent = loaded.agents[s.by]
        if (!agent) continue
        for (const file of s.writes) docs.push({ file, instructions: (skill?.prompt ?? skill?.description ?? "").trim(), agent })
      }
    }
  }
  walk(loaded.manifest.phases.discovery)
  return docs
}

/** Checks the brief and the chosen pack's discovery documents (placeholders count as missing). */
export async function checkDiscovery(paths: ProjectPaths): Promise<DiscoveryCheck> {
  const rel = path.relative(paths.root, paths.brief)
  if (!(await isFile(paths.brief))) return { done: false, missing: [rel] }
  const pack = await chosenPack(paths)
  if (!pack.name) return { done: false, missing: [`\`pack:\` in the frontmatter of ${rel}`] }
  if (!pack.installed) return { done: false, missing: [`installed pack '${pack.name}' (named in ${rel})`] }
  const missing: string[] = []
  for (const doc of await discoveryDocs(pack.installed)) {
    const text = await readTextOr(path.join(paths.root, doc.file), "")
    if (!text.trim() || text.includes(PLACEHOLDER_MARKER)) missing.push(doc.file)
  }
  return { done: missing.length === 0, pack: pack.installed, missing }
}

/**
 * Opens (or reopens) the discovery conversation in OpenCode and waits for the user to quit it.
 * Returns the outputs check afterwards.
 */
export async function runDiscovery(paths: ProjectPaths, config: ProjectConfig, opts: { fresh?: boolean } = {}): Promise<DiscoveryCheck> {
  const opencode = Bun.which("opencode")
  if (!opencode) throw new CliError("discovery runs in OpenCode, and `opencode` is not on PATH", "install OpenCode (https://opencode.ai), then run `slate discover`")
  const core = await loadCorePack()
  const docsByPack = await writeAgents(paths, config, core)

  let record = await readDiscovery(paths)
  const args = [opencode]
  if (opts.fresh || record.job || !record.session) {
    record = { session: await createSession(opencode, paths.root, config), startedAt: new Date().toISOString() }
    await writeDiscovery(paths, record)
    // The app sends the first message itself, so the lead starts the interview on open.
    args.push("--session", record.session!, "--prompt", renderPrompt(core, "discovery-start", { project: config.name }))
  } else {
    args.push("--session", record.session!)
  }
  args.push(paths.root)

  const stopWatching = watchPackChoice(paths, docsByPack, core)
  try {
    const proc = Bun.spawn(args, { cwd: paths.root, stdio: ["inherit", "inherit", "inherit"] })
    await proc.exited
  } finally {
    stopWatching()
  }
  await scaffoldChosenPack(paths, docsByPack, core)

  const check = await checkDiscovery(paths)
  if (check.done) await writeDiscovery(paths, { ...record, pack: `${check.pack!.name}@${check.pack!.version}`, completedAt: new Date().toISOString() })
  return check
}

/* ------------------------------------------------------------------ agents */

type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
export type PackDocs = Map<string, { pack: InstalledPack; docs: (DiscoveryDoc & { subagent: string })[] }>

/**
 * Writes the discovery lead and one subagent per drafting pack agent into `.opencode/agents/`.
 * Subagents are named `slate-<agent>`, or `slate-<pack>-<agent>` when two packs share an agent id.
 */
export async function writeAgents(paths: ProjectPaths, config: ProjectConfig, core: CorePack): Promise<PackDocs> {
  // `pack:` in slate.config.yml limits discovery to that pack.
  const pinned = config.pack ? await findPack(config.pack, paths.root) : undefined
  if (config.pack && !pinned) throw new CliError(`pack '${config.pack}' from slate.config.yml is not installed`, "run `slate pack list`, or `slate pack add <dir>`")
  const packs = pinned ? [pinned] : (await listInstalledPacks(paths.root)).filter((p) => p.version !== "invalid")
  if (!packs.length) throw new CliError("no workflow pack is installed", "install one with `slate pack add <dir>`, then run `slate discover`")

  const raw = await Promise.all(packs.map(async (pack) => ({ pack, docs: await discoveryDocs(pack) })))
  const packsPerAgent = new Map<string, Set<string>>()
  for (const { pack, docs } of raw) for (const d of docs) packsPerAgent.set(d.agent.id, (packsPerAgent.get(d.agent.id) ?? new Set()).add(pack.name))
  const nameOf = (pack: string, agent: string) => (packsPerAgent.get(agent)!.size > 1 ? `slate-${pack}-${agent}` : `slate-${agent}`)

  const byPack: PackDocs = new Map()
  const agentsDir = path.join(paths.root, ".opencode", "agents")
  const model = (tier: "low" | "medium" | "high") => `${config.provider}/${config.models[tier]}`
  // OpenCode checks files inside the project by their project-relative path, so rules use those.
  const rel = (file: string) => path.relative(paths.root, path.resolve(paths.root, file)).replaceAll("\\", "/")
  for (const { pack, docs } of raw) {
    const named = docs.map((d) => ({ ...d, subagent: nameOf(pack.name, d.agent.id) }))
    byPack.set(pack.name, { pack, docs: named })
    for (const [subagent, agent] of new Map(named.map((d) => [d.subagent, d.agent]))) {
      // Subagents run without the person: no questions, no nesting, no shell; edits stay in scope.
      const editable = agent.scope.modify?.length ? agent.scope.modify : named.filter((d) => d.subagent === subagent).map((d) => d.file)
      const permissions: PermissionRule[] = [
        ...(agent.permissions as PermissionRule[]),
        { action: "question", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "deny" },
        ...editable.map((g): PermissionRule => ({ action: "edit", resource: rel(g), effect: "allow" })),
      ]
      const body = renderPrompt(core, "discovery-subagent", { agent_prompt: agent.prompt.trim(), project: config.name })
      await writeAgentFile(path.join(agentsDir, `${subagent}.md`), { description: `${agent.description} (Slate discovery, pack ${pack.name})`, mode: "subagent", model: model(agent.model), permissions }, body)
    }
  }

  const sections = [...byPack.values()].map(({ pack, docs }) =>
    [
      `## ${pack.name}`,
      `Fits: ${pack.fits || pack.description}`,
      docs.length ? "Discovery documents, in order:" : "Discovery documents: none beyond the brief.",
      ...docs.map((d) => `- \`${d.file}\`, drafted by subagent \`${d.subagent}\`. Instructions:\n  ${d.instructions.split("\n").join("\n  ")}`),
    ].join("\n"),
  )
  const lead: PermissionRule[] = [
    { action: "question", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
    // The lead writes the brief only; documents go to the pack's specialists.
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: rel(paths.brief), effect: "allow" },
  ]
  const body = renderPrompt(core, "discovery-agent", { project: config.name, brief_path: path.relative(paths.root, paths.brief), packs: sections.join("\n\n") })
  await writeAgentFile(path.join(agentsDir, `${DISCOVERY_AGENT}.md`), { description: "Slate discovery. Interviews you about what to build, picks the pack, and has its specialists write the discovery docs.", mode: "primary", model: model("high"), permissions: lead }, body)
  return byPack
}

/** An OpenCode agent file: YAML frontmatter (agent config) and the system prompt as the body. */
async function writeAgentFile(file: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  await writeText(file, `---\n${YAML.stringify(frontmatter)}---\n${body}\n`)
}

/* ------------------------------------------------------------------ session */

/** Creates the lead's session through the OpenCode service; no model call happens yet. */
async function createSession(opencode: string, root: string, config: ProjectConfig): Promise<string> {
  const body = { location: { directory: root }, agent: DISCOVERY_AGENT, model: { providerID: config.provider, id: config.models.high }, title: `Slate discovery: ${config.name}` }
  const proc = Bun.spawn([opencode, "api", "session.create", "--data", JSON.stringify(body)], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  try {
    const id = JSON.parse(stdout)?.data?.id
    if (code === 0 && typeof id === "string") return id
  } catch {
    /* fall through to the error */
  }
  throw new CliError(`could not create the discovery session in OpenCode (exit ${code}): ${(stderr || stdout).trim().split("\n").slice(0, 3).join(" ").slice(0, 400)}`, "check that `opencode` works in this directory (`opencode service status`), then run `slate discover`")
}

/* --------------------------------------------------------------- pack choice */

/** Polls the brief while the app is open; scaffolds the chosen pack's documents once it names one. */
function watchPackChoice(paths: ProjectPaths, docsByPack: PackDocs, core: CorePack): () => void {
  let done = false
  let busy = false
  const timer = setInterval(async () => {
    if (done || busy) return
    busy = true
    try {
      done = await scaffoldChosenPack(paths, docsByPack, core)
    } catch {
      /* try again on the next tick */
    } finally {
      busy = false
    }
  }, 1000)
  return () => clearInterval(timer)
}

/** Creates placeholders for the chosen pack's missing documents. Returns true once a pack is chosen. */
export async function scaffoldChosenPack(paths: ProjectPaths, docsByPack: PackDocs, core: CorePack): Promise<boolean> {
  const { name } = await chosenPack(paths)
  const entry = name ? docsByPack.get(name) : undefined
  if (!entry) return false
  for (const doc of entry.docs) {
    const file = path.join(paths.root, doc.file)
    if (await isFile(file)) continue
    await writeText(file, renderPrompt(core, "discovery-stub", { marker: PLACEHOLDER_MARKER, file: doc.file, agent: `\`${doc.subagent}\``, instructions: doc.instructions }) + "\n")
  }
  return true
}

/** The pack named in the brief's frontmatter, and whether it is installed. */
async function chosenPack(paths: ProjectPaths): Promise<{ name?: string; installed?: InstalledPack }> {
  const front = frontmatter(await readTextOr(paths.brief, ""))
  const name = typeof front.pack === "string" ? front.pack.trim().replace(/@.*$/, "") : ""
  if (!name) return {}
  return { name, installed: await findPack(name, paths.root) }
}

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/^﻿/, ""))
  if (!m) return {}
  try {
    return (YAML.parse(m[1]!) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}
