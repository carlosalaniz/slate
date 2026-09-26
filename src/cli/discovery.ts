import path from "node:path"
import YAML from "yaml"
import type { ProjectConfig } from "../config/project.ts"
import type { ProjectPaths } from "../config/paths.ts"
import type { AgentSpec, Step } from "../pack/schema.ts"
import { writeCatalog } from "../engine/capabilities.ts"
import { loadPack } from "../pack/loader.ts"
import { listInstalledPacks, findPack, type InstalledPack } from "../pack/registry.ts"
import { loadCorePack, renderPrompt } from "../engine/core-pack.ts"
import type { CorePack } from "../engine/types.ts"
import { rename } from "node:fs/promises"
import { ensureDir, isFile, readTextOr, removePath, writeJsonAtomic, writeText } from "../util/fs.ts"
import { CliError } from "./output.ts"

/**
 * Discovery is a live conversation in the user's own OpenCode, in two parts:
 * 1. Slate's core lead (`.opencode/agents/slate-discovery.md`) asks what the person is building and
 *    which installed pack fits, then writes the start of the brief naming the pack.
 * 2. Slate hands the same session to the pack's own discovery lead (`slate-<pack>`: the pack's
 *    `discovery.lead` prompt plus Slate's rules), which runs the rest of the interview and has the
 *    pack's specialists (`slate-<agent>` subagents) write the discovery documents.
 * Slate creates the session through the OpenCode service and opens the app on it with the first
 * message. Discovery is done when the brief names an installed pack and every document is written.
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
  /** Set when the session was handed to the chosen pack's discovery lead. */
  handoff?: { pack: string; agent: string; at: string }
  /** The job that consumed this discovery; the next job needs a new one. */
  job?: string
}

export interface DiscoveryCheck {
  done: boolean
  pack?: InstalledPack
  /** Human-readable list of what is still missing. */
  missing: string[]
}

/**
 * How `slate discover` treats an unfinished discovery: reopen the same conversation, start a new one
 * for the current stage (keeping what was written), or start over (archiving what was written).
 */
export type DiscoveryMode = "continue" | "restart" | "new"

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
      if (s.type === "loop" || s.type === "parallel") walk(s.steps)
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
 * Slate's core lead asks what to build and which pack; once the brief names the pack, the session
 * is handed to that pack's discovery lead (in place, while the app is open, or right after it
 * closes, reopening it). Returns the outputs check afterwards.
 */
export async function runDiscovery(paths: ProjectPaths, config: ProjectConfig, opts: { mode?: DiscoveryMode } = {}): Promise<DiscoveryCheck> {
  const opencode = Bun.which("opencode")
  if (!opencode) throw new CliError("discovery runs in OpenCode, and `opencode` is not on PATH", "install OpenCode (https://opencode.ai), then run `slate discover`")
  const core = await loadCorePack()
  await writeCoreLead(paths, config, core)

  let record = await readDiscovery(paths)
  let firstMessage: string | undefined
  // Nothing to continue (or it belonged to an earlier job): a new conversation.
  const mode: DiscoveryMode = !record.session || record.job ? "new" : (opts.mode ?? "continue")
  const chosen = await chosenPack(paths)
  if (mode === "restart" && record.handoff && chosen.installed) {
    // A fresh conversation straight with the pack's lead; the brief and documents so far stay.
    const { lead, docs } = await writePackAgents(paths, config, core, chosen.installed)
    await scaffoldDocs(paths, docs, core)
    const session = await createSession(opencode, paths.root, config, lead, chosen.installed.name)
    record = { session, startedAt: new Date().toISOString(), handoff: { pack: chosen.installed.name, agent: lead, at: new Date().toISOString() } }
    await writeDiscovery(paths, record)
    firstMessage = renderPrompt(core, "discovery-handoff", { pack: chosen.installed.name, brief_path: path.relative(paths.root, paths.brief) })
  } else if (mode !== "continue") {
    // "new" moves what was written aside; "restart" before the handoff has nothing written to keep.
    if (mode === "new" && record.session && !record.job) await archiveDiscovery(paths)
    record = { session: await createSession(opencode, paths.root, config), startedAt: new Date().toISOString() }
    await writeDiscovery(paths, record)
    // The app sends the first message itself, so the lead starts the interview on open.
    firstMessage = renderPrompt(core, "discovery-start", { project: config.name })
  }
  const session = record.session!
  const handedTo = async () => (await readDiscovery(paths)).handoff?.pack

  while (true) {
    // Reopening after the handoff: refresh the pack's agents so edits to the pack apply.
    const chosen = await chosenPack(paths)
    if (chosen.installed && (await handedTo()) === chosen.name) await writePackAgents(paths, config, core, chosen.installed)
    const stopWatching = watchPackChoice(paths, async (pack) => {
      if ((await handedTo()) !== pack.name) await handOff(opencode, paths, config, core, session, pack)
    })
    let stopDone: (() => void) | undefined
    try {
      const args = [opencode, "--session", session, ...(firstMessage ? ["--prompt", firstMessage] : []), paths.root]
      firstMessage = undefined
      const proc = Bun.spawn(args, { cwd: paths.root, stdio: ["inherit", "inherit", "inherit"] })
      // When the lead marks discovery done and every document is written, close the app for them
      // (OpenCode exits cleanly on SIGINT, restoring the terminal).
      stopDone = watchFinished(paths, () => proc.kill("SIGINT"))
      await proc.exited
    } finally {
      stopWatching()
      stopDone?.()
    }
    // Picked just before quitting, or the in-app switch failed: hand off now and reopen the app.
    const after = await chosenPack(paths)
    if (!after.installed || (await handedTo()) === after.name) break
    await handOff(opencode, paths, config, core, session, after.installed)
  }

  const check = await checkDiscovery(paths)
  if (check.done) await writeDiscovery(paths, { ...(await readDiscovery(paths)), pack: `${check.pack!.name}@${check.pack!.version}`, completedAt: new Date().toISOString() })
  return check
}

/**
 * Hands the session to the pack's discovery lead: writes the pack's agents and document
 * placeholders, switches the session's agent and sends the lead its first message.
 */
async function handOff(opencode: string, paths: ProjectPaths, config: ProjectConfig, core: CorePack, session: string, pack: InstalledPack): Promise<void> {
  const { lead, docs } = await writePackAgents(paths, config, core, pack)
  await scaffoldDocs(paths, docs, core)
  // OpenCode reloads agent files shortly after they change; give it a moment to see the new lead.
  await Bun.sleep(1500)
  await api(opencode, paths.root, "session.switchAgent", session, { agent: lead })
  await api(opencode, paths.root, "session.prompt", session, { text: renderPrompt(core, "discovery-handoff", { pack: pack.name, brief_path: path.relative(paths.root, paths.brief) }) })
  await writeDiscovery(paths, { ...(await readDiscovery(paths)), handoff: { pack: pack.name, agent: lead, at: new Date().toISOString() } })
}

/** The brief and the chosen pack's documents that exist and are not placeholders. */
export async function discoveryFiles(paths: ProjectPaths): Promise<string[]> {
  const files: string[] = []
  if (await isFile(paths.brief)) files.push(path.relative(paths.root, paths.brief))
  const { installed } = await chosenPack(paths)
  for (const doc of installed ? await discoveryDocs(installed) : []) {
    const text = await readTextOr(path.join(paths.root, doc.file), "")
    if (text.trim() && !text.includes(PLACEHOLDER_MARKER)) files.push(doc.file)
  }
  return files
}

/** Moves the brief and discovery documents to `.slate/archive/discovery-<time>/`; returns that folder. */
export async function archiveDiscovery(paths: ProjectPaths): Promise<string | undefined> {
  const files = await discoveryFiles(paths)
  const { installed } = await chosenPack(paths)
  // Placeholders are Slate's, not the person's work: they are simply removed.
  for (const doc of installed ? await discoveryDocs(installed) : []) {
    const file = path.join(paths.root, doc.file)
    if ((await readTextOr(file, "")).includes(PLACEHOLDER_MARKER)) await removePath(file)
  }
  if (!files.length) return undefined
  const dir = path.join(paths.slate, "archive", `discovery-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  for (const f of files) {
    const from = path.join(paths.root, f)
    if (!(await isFile(from))) continue
    await ensureDir(path.dirname(path.join(dir, f)))
    await rename(from, path.join(dir, f))
  }
  return dir
}

/* ------------------------------------------------------------------ agents */

type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
export type NamedDoc = DiscoveryDoc & { subagent: string }

/** OpenCode checks files inside the project by their project-relative path, so rules use those. */
const relTo = (paths: ProjectPaths) => (file: string) => path.relative(paths.root, path.resolve(paths.root, file)).replaceAll("\\", "/")

/** Slate's core lead: asks what to build and which of the installed packs; writes only the brief. */
export async function writeCoreLead(paths: ProjectPaths, config: ProjectConfig, core: CorePack): Promise<void> {
  // `pack:` in slate.config.yml limits the choice to that pack.
  const pinned = config.pack ? await findPack(config.pack, paths.root) : undefined
  if (config.pack && !pinned) throw new CliError(`pack '${config.pack}' from slate.config.yml is not installed`, "run `slate pack list`, or `slate pack add <dir>`")
  const packs = pinned ? [pinned] : (await listInstalledPacks(paths.root)).filter((p) => p.version !== "invalid")
  if (!packs.length) throw new CliError("no workflow pack is installed", "install one with `slate pack add <dir>`, then run `slate discover`")
  const rel = relTo(paths)
  // The pack question's options, verbatim, so the lead cannot offer packs that are not installed.
  const packOptions = packs.map((p) => `   - label: ${p.name}\n     description: ${p.fits || p.description}`).join("\n")
  const body = renderPrompt(core, "discovery-agent", { project: config.name, brief_path: rel(paths.brief), pack_options: packOptions })
  const permissions: PermissionRule[] = [
    { action: "question", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: rel(paths.brief), effect: "allow" },
  ]
  await writeAgentFile(path.join(paths.root, ".opencode", "agents", `${DISCOVERY_AGENT}.md`), { description: "Slate discovery: what you are building and which workflow pack; then the pack takes over.", mode: "primary", model: `${config.provider}/${config.models.high}`, permissions }, body)
}

/**
 * The chosen pack's discovery agents: its lead (`slate-<pack>`, primary; the pack's
 * `discovery.lead` prompt plus Slate's rules) and one subagent per agent that drafts a document
 * (`slate-<agent>`). Returns the lead's name and the documents with their subagents.
 */
export async function writePackAgents(paths: ProjectPaths, config: ProjectConfig, core: CorePack, pack: InstalledPack): Promise<{ lead: string; docs: NamedDoc[] }> {
  const loaded = await loadPack(pack.dir)
  // The installed skills and tools, so the architect can map what the product needs to them.
  await writeCatalog(paths.root, loaded, core)
  const docs: NamedDoc[] = (await discoveryDocs(pack)).map((d) => ({ ...d, subagent: `slate-${d.agent.id}` }))
  const agentsDir = path.join(paths.root, ".opencode", "agents")
  const model = (tier: "low" | "medium" | "high") => `${config.provider}/${config.models[tier]}`
  const rel = relTo(paths)

  for (const [subagent, agent] of new Map(docs.map((d) => [d.subagent, d.agent]))) {
    // Subagents run without the person: no questions, no nesting, no shell; edits stay in scope.
    const editable = agent.scope.modify?.length ? agent.scope.modify : docs.filter((d) => d.subagent === subagent).map((d) => d.file)
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

  const leadSpec = loaded.manifest.discovery.lead ? loaded.agents[loaded.manifest.discovery.lead] : undefined
  const docList = docs.length
    ? ["Discovery documents, in order:", ...docs.map((d) => `  - \`${d.file}\`: subagent \`${d.subagent}\`. Instructions:\n    ${d.instructions.split("\n").join("\n    ")}`)].join("\n")
    : "This pack needs no discovery documents beyond the brief."
  const rules = renderPrompt(core, "discovery-pack-lead", { pack: pack.name, brief_path: rel(paths.brief), docs: docList })
  const body = [leadSpec?.prompt.trim(), rules].filter(Boolean).join("\n\n")
  const lead = `slate-${pack.name}`
  const permissions: PermissionRule[] = [
    { action: "question", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
    // The lead writes the brief only; documents go to the pack's specialists.
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: rel(paths.brief), effect: "allow" },
  ]
  await writeAgentFile(path.join(agentsDir, `${lead}.md`), { description: leadSpec?.description || `Discovery for the ${pack.name} pack.`, mode: "primary", model: model(leadSpec?.model ?? "high"), permissions }, body)
  return { lead, docs }
}

/** An OpenCode agent file: YAML frontmatter (agent config) and the system prompt as the body. */
async function writeAgentFile(file: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  await writeText(file, `---\n${YAML.stringify(frontmatter)}---\n${body}\n`)
}

/* ------------------------------------------------------------------ session */

/** Creates the lead's session through the OpenCode service; no model call happens yet. */
async function createSession(opencode: string, root: string, config: ProjectConfig, agent = DISCOVERY_AGENT, pack?: string): Promise<string> {
  const body = { location: { directory: root }, agent, model: { providerID: config.provider, id: config.models.high }, title: `Slate discovery: ${config.name}${pack ? ` (${pack})` : ""}` }
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

/** Calls an OpenCode service operation on one session; throws with its error output on failure. */
async function api(opencode: string, root: string, operation: string, sessionID: string, data: Record<string, unknown>): Promise<void> {
  const proc = Bun.spawn([opencode, "api", operation, "--param", `sessionID=${sessionID}`, "--data", JSON.stringify(data)], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`opencode api ${operation} failed (exit ${code}): ${stderr.trim().split("\n")[0]}`)
}

/* --------------------------------------------------------------- pack choice */

/** Polls the brief while the app is open and calls `onPack` once it names an installed pack. */
function watchPackChoice(paths: ProjectPaths, onPack: (pack: InstalledPack) => Promise<void>): () => void {
  let done = false
  let busy = false
  const timer = setInterval(async () => {
    if (done || busy) return
    busy = true
    try {
      const { installed } = await chosenPack(paths)
      if (installed) {
        await onPack(installed)
        done = true
      }
    } catch {
      /* try again on the next tick; after the app closes Slate hands off again if needed */
    } finally {
      busy = false
    }
  }, 1000)
  return () => clearInterval(timer)
}

/** Polls for a finished discovery: `status: done` in the brief and every document written. */
function watchFinished(paths: ProjectPaths, onDone: () => void): () => void {
  let fired = false
  const timer = setInterval(async () => {
    if (fired) return
    try {
      if (frontmatter(await readTextOr(paths.brief, "")).status !== "done" || !(await checkDiscovery(paths)).done) return
      fired = true
      // Leave the lead's closing sentence on screen for a moment.
      setTimeout(onDone, 4000)
    } catch {
      /* try again on the next tick */
    }
  }, 1500)
  return () => clearInterval(timer)
}

/** Creates placeholders for the documents that do not exist yet. */
export async function scaffoldDocs(paths: ProjectPaths, docs: NamedDoc[], core: CorePack): Promise<void> {
  for (const doc of docs) {
    const file = path.join(paths.root, doc.file)
    if (await isFile(file)) continue
    await writeText(file, renderPrompt(core, "discovery-stub", { marker: PLACEHOLDER_MARKER, file: doc.file, agent: `\`${doc.subagent}\``, instructions: doc.instructions }) + "\n")
  }
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
