import path from "node:path"
import YAML from "yaml"
import type { ProjectConfig } from "../config/project.ts"
import type { ProjectPaths } from "../config/paths.ts"
import type { Step } from "../pack/schema.ts"
import { loadPack } from "../pack/loader.ts"
import { listInstalledPacks, findPack, type InstalledPack } from "../pack/registry.ts"
import { loadCorePack, renderPrompt } from "../engine/core-pack.ts"
import { isFile, readTextOr, writeJsonAtomic, writeText } from "../util/fs.ts"
import { CliError } from "./output.ts"
import { spin } from "./prompt.ts"

/**
 * Discovery is a live conversation in the user's own OpenCode: Slate writes its discovery agent
 * into the project's `.opencode/agents/`, seeds a session with `opencode run`, then opens the
 * OpenCode app on it. It is done when the brief names an installed pack and every discovery
 * document that pack asks for exists. Jobs start after discovery, at the plan phase.
 */

export const DISCOVERY_AGENT = "slate-discovery"

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
export async function discoveryDocs(pack: InstalledPack): Promise<{ file: string; instructions: string }[]> {
  const loaded = await loadPack(pack.dir)
  const docs: { file: string; instructions: string }[] = []
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      if (s.type === "loop") walk(s.steps)
      else if (s.type === "skill" && s.writes?.length) {
        const skill = loaded.skills[s.skill]
        for (const file of s.writes) docs.push({ file, instructions: (skill?.prompt ?? skill?.description ?? "").trim() })
      }
    }
  }
  walk(loaded.manifest.phases.discovery)
  return docs
}

/** Checks the brief and the chosen pack's discovery documents. */
export async function checkDiscovery(paths: ProjectPaths): Promise<DiscoveryCheck> {
  const rel = path.relative(paths.root, paths.brief)
  if (!(await isFile(paths.brief))) return { done: false, missing: [rel] }
  const front = frontmatter(await readTextOr(paths.brief, ""))
  const name = typeof front.pack === "string" ? front.pack.trim() : ""
  if (!name) return { done: false, missing: [`\`pack:\` in the frontmatter of ${rel}`] }
  const pack = await findPack(name, paths.root)
  if (!pack) return { done: false, missing: [`installed pack '${name}' (named in ${rel})`] }
  const missing: string[] = []
  for (const doc of await discoveryDocs(pack)) if (!(await isFile(path.join(paths.root, doc.file)))) missing.push(doc.file)
  return { done: missing.length === 0, pack, missing }
}

/**
 * Opens (or reopens) the discovery conversation in OpenCode and waits for the user to quit it.
 * Returns the outputs check afterwards.
 */
export async function runDiscovery(paths: ProjectPaths, config: ProjectConfig, opts: { fresh?: boolean } = {}): Promise<DiscoveryCheck> {
  const opencode = Bun.which("opencode")
  if (!opencode) throw new CliError("discovery runs in OpenCode, and `opencode` is not on PATH", "install OpenCode (https://opencode.ai), then run `slate discover`")
  await writeAgent(paths, config)

  let record = await readDiscovery(paths)
  if (opts.fresh || record.job || !record.session) {
    const core = await loadCorePack()
    const seed = renderPrompt(core, "discovery-start", { project: config.name })
    const session = await spin("starting discovery in OpenCode…", seedSession(opencode, paths.root, config, seed))
    record = { session, startedAt: new Date().toISOString() }
    await writeDiscovery(paths, record)
  }

  const proc = Bun.spawn([opencode, "--session", record.session!, paths.root], { cwd: paths.root, stdio: ["inherit", "inherit", "inherit"] })
  await proc.exited

  const check = await checkDiscovery(paths)
  if (check.done) await writeDiscovery(paths, { ...record, pack: `${check.pack!.name}@${check.pack!.version}`, completedAt: new Date().toISOString() })
  return check
}

/** Writes `.opencode/agents/slate-discovery.md` from slate-core's template and the installed packs. */
async function writeAgent(paths: ProjectPaths, config: ProjectConfig): Promise<void> {
  // `pack:` in slate.config.yml limits discovery to that pack.
  const pinned = config.pack ? await findPack(config.pack, paths.root) : undefined
  if (config.pack && !pinned) throw new CliError(`pack '${config.pack}' from slate.config.yml is not installed`, "run `slate pack list`, or `slate pack add <dir>`")
  const packs = pinned ? [pinned] : (await listInstalledPacks(paths.root)).filter((p) => p.version !== "invalid")
  if (!packs.length) throw new CliError("no workflow pack is installed", "install one with `slate pack add <dir>`, then run `slate discover`")
  const sections: string[] = []
  for (const p of packs) {
    const docs = await discoveryDocs(p)
    sections.push(
      [`## ${p.name}`, `Fits: ${p.fits || p.description}`, docs.length ? "Discovery documents:" : "Discovery documents: none beyond the brief.", ...docs.map((d) => `- \`${d.file}\`: ${indent(d.instructions)}`)].join("\n"),
    )
  }
  const core = await loadCorePack()
  const agent = renderPrompt(core, "discovery-agent", {
    project: config.name,
    model: `${config.provider}/${config.models.high}`,
    brief_path: path.relative(paths.root, paths.brief),
    packs: sections.join("\n\n"),
  })
  await writeText(path.join(paths.root, ".opencode", "agents", `${DISCOVERY_AGENT}.md`), agent + "\n")
}

/** Runs the first turn headlessly so the app opens on a conversation that already started. */
async function seedSession(opencode: string, root: string, config: ProjectConfig, message: string): Promise<string> {
  const proc = Bun.spawn(
    [opencode, "run", "--agent", DISCOVERY_AGENT, "--model", `${config.provider}/${config.models.high}`, "--title", `Slate discovery: ${config.name}`, "--format", "json", message],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  for (const line of stdout.split("\n")) {
    try {
      const id = JSON.parse(line)?.sessionID
      if (typeof id === "string") return id
    } catch {
      /* not a JSON event */
    }
  }
  throw new CliError(`could not start the discovery session in OpenCode (exit ${code}): ${(stderr || stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`, "check that `opencode` works in this directory, then run `slate discover`")
}

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/^\uFEFF/, ""))
  if (!m) return {}
  try {
    return (YAML.parse(m[1]!) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

function indent(text: string): string {
  return text.split("\n").join("\n  ")
}
