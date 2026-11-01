import os from "node:os"
import path from "node:path"
import { mkdtemp, cp, rm, readdir } from "node:fs/promises"
import YAML from "yaml"
import { installedDir, readLock, type LockEntry } from "../pack/loader.ts"
import { isFile, readText, writeText } from "../util/fs.ts"
import { parseFrontmatter } from "../util/frontmatter.ts"

/**
 * marketplace — finding what a project needs instead of writing it.
 *
 * Skills come from skills.sh (the open agent skills index: `SKILL.md` folders in GitHub
 * repositories, searched through its `/api/search`). Tools come from the official MCP Registry
 * (`/v0/servers`), as local MCP servers run from npm or PyPI at a pinned version. A person picks;
 * Slate copies the skill folder at a commit, or writes a capability for the server, into
 * `.slate/installed/` and records it in `lock.yaml`. Nothing here runs what it installs.
 */

export interface SkillHit {
  kind: "skill"
  /** owner/repo (a local path or git URL works too). */
  source: string
  skillId: string
  name: string
  installs: number
}

export interface ToolHit {
  kind: "tool"
  /** Registry name, e.g. io.github.mindstone/mcp-server-elevenlabs */
  name: string
  version: string
  description: string
  command: string[]
  /** Variables the server needs (the registry's required environment variables). */
  env: string[]
  /** Everything else the registry says about its variables, for the person to read. */
  envNotes: string[]
  repository?: string
}

export type Hit = SkillHit | ToolHit

export async function searchSkills(base: string, query: string, limit = 8): Promise<SkillHit[]> {
  const res = await fetch(`${base.replace(/\/$/, "")}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`skill search failed: HTTP ${res.status}`)
  const body = (await res.json()) as { skills?: { source?: string; skillId?: string; name?: string; installs?: number }[] }
  return (body.skills ?? [])
    .filter((s) => s.source && (s.skillId || s.name))
    .map((s) => ({ kind: "skill" as const, source: s.source!, skillId: s.skillId ?? s.name!, name: s.name ?? s.skillId!, installs: s.installs ?? 0 }))
}

interface RegistryPackage {
  registryType?: string
  identifier?: string
  version?: string
  transport?: { type?: string }
  packageArguments?: { type?: string; value?: string; name?: string }[]
  environmentVariables?: { name: string; isRequired?: boolean; description?: string }[]
}

/** Latest version of each server that runs locally over stdio from npm or PyPI. */
export async function searchTools(base: string, query: string, limit = 5): Promise<ToolHit[]> {
  const res = await fetch(`${base.replace(/\/$/, "")}/v0/servers?search=${encodeURIComponent(query)}&limit=100`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`tool search failed: HTTP ${res.status}`)
  const body = (await res.json()) as { servers?: { server: { name: string; version: string; description?: string; packages?: RegistryPackage[]; repository?: { url?: string } }; _meta?: Record<string, { isLatest?: boolean }> }[] }
  const out: ToolHit[] = []
  for (const entry of body.servers ?? []) {
    const latest = entry._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest
    if (latest === false) continue
    const s = entry.server
    const pkg = (s.packages ?? []).find((p) => (p.registryType === "npm" || p.registryType === "pypi") && (p.transport?.type ?? "stdio") === "stdio" && p.identifier && p.version)
    if (!pkg) continue
    const args = (pkg.packageArguments ?? []).filter((a) => a.type === "positional" && a.value).map((a) => a.value!)
    const command = pkg.registryType === "npm" ? ["npx", "-y", `${pkg.identifier}@${pkg.version}`, ...args] : ["uvx", `${pkg.identifier}==${pkg.version}`, ...args]
    const vars = pkg.environmentVariables ?? []
    out.push({
      kind: "tool",
      name: s.name,
      version: s.version,
      description: s.description ?? "",
      command,
      env: vars.filter((v) => v.isRequired).map((v) => v.name),
      envNotes: vars.map((v) => `${v.name}${v.isRequired ? " (required)" : ""}${v.description ? `: ${v.description}` : ""}`),
      repository: s.repository?.url,
    })
    if (out.length >= limit) break
  }
  return out
}

/* --------------------------------------------------------------------------- skills */

/** A skill fetched for review: nothing is installed until `installSkill`. */
export interface FetchedSkill {
  id: string
  source: string
  commit: string
  /** The folder inside the repository. */
  path: string
  /** Where it was checked out (a temporary directory; `dispose` removes it). */
  dir: string
  description: string
  compatibility?: string
  env: string[]
  /** Keys the skill's text reads without declaring them (`process.env.DEEPGRAM_API_KEY`, `os.environ["..."]`). */
  envFound: string[]
  /** The outside service it works through, when it names one (its `homepage`, or the site it links to most). */
  service?: string
  /** Setup it asks for before it works: installing a CLI or package, logging in. */
  setup: string[]
  /** Every file in the folder; scripts are the ones that can run code. */
  files: string[]
  scripts: string[]
  skillMd: string
  dispose(): Promise<void>
}

function repoUrl(source: string): string {
  if (/^(https?|git|ssh|file):/.test(source) || source.startsWith("/") || source.startsWith(".")) return source
  return `https://github.com/${source}.git`
}

async function git(args: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  if ((await p.exited) !== 0) throw new Error(`git ${args[0]} failed: ${err.trim().split("\n").slice(-1)[0]}`)
  return out.trim()
}

/** Shallow-clones the repository and finds the skill's folder: named after it, or whose SKILL.md names it. */
export async function fetchSkill(source: string, skillId: string): Promise<FetchedSkill> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slate-skill-"))
  const dispose = () => rm(tmp, { recursive: true, force: true })
  try {
    await git(["clone", "-q", "--depth", "1", repoUrl(source), tmp])
    const commit = await git(["rev-parse", "HEAD"], tmp)
    const found = await findSkillFolder(tmp, skillId)
    if (!found) throw new Error(`${source} has no skill '${skillId}' (no folder with a SKILL.md for it)`)
    const skillMd = await readText(path.join(found, "SKILL.md"))
    const { data } = parseFrontmatter(skillMd)
    const metadata = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, { requires?: { env?: unknown } }>
    const env = new Set<string>()
    for (const v of Object.values(metadata)) for (const n of Array.isArray(v?.requires?.env) ? v.requires!.env : []) if (typeof n === "string") env.add(n)
    const files = await listFiles(found)
    const texts = await Promise.all(files.filter((f) => /\.(md|txt)$/i.test(f)).map((f) => readText(path.join(found, f))))
    const envFound = [...new Set(texts.flatMap(secretsRead))].filter((k) => !env.has(k))
    const homepage = typeof data.homepage === "string" ? data.homepage : undefined
    return {
      service: serviceOf(homepage, texts),
      setup: [...new Set(texts.flatMap(setupCommands))].slice(0, 6),
      id: skillId,
      source,
      commit,
      path: path.relative(tmp, found),
      dir: found,
      description: typeof data.description === "string" ? data.description : "",
      compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
      env: [...env],
      envFound,
      files,
      scripts: files.filter((f) => /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|exe)$/i.test(f) || f.startsWith("scripts/") || f.startsWith("bin/")),
      skillMd,
      dispose,
    }
  } catch (e) {
    await dispose()
    throw e
  }
}

/** Hosts that are about code, not a service a skill works through. */
const NOT_SERVICES = /(^|\.)(github\.com|githubusercontent\.com|skills\.sh|npmjs\.com|pypi\.org|agentskills\.io|shields\.io|wikipedia\.org|mozilla\.org|nodejs\.org|python\.org|typescriptlang\.org)$/

/** The service's site: the skill's `homepage`, else the host its text links to most (ignoring code hosts). */
export function serviceOf(homepage: string | undefined, texts: string[]): string | undefined {
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^(www|docs|api)\./, "")
    } catch {
      return undefined
    }
  }
  if (homepage && host(homepage)) return host(homepage)
  const counts = new Map<string, number>()
  for (const t of texts) for (const m of t.matchAll(/https?:\/\/[^\s)"'>\]]+/g)) {
    const h = host(m[0])
    if (h && !NOT_SERVICES.test(h)) counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]
  return best && best[1] >= 2 ? best[0] : undefined
}

/** Setup lines the text asks for: installing a global CLI or package, logging in to a service. */
export function setupCommands(text: string): string[] {
  const out: string[] = []
  const re = /^\s*\$?\s*((?:npm (?:i|install) (?:-g|--global)|pnpm add -g|bun (?:add|install) -g|yarn global add|pip3? install|pipx install|uv tool install|brew install|cargo install|go install|gem install)\s+[^\s#`]+|curl [^\n#`]*\|\s*(?:ba)?sh|[a-z][a-z0-9-]* (?:login|auth login))/gm
  for (const m of text.matchAll(re)) out.push(m[1]!.trim())
  return out
}

/** Secret-looking variables code in the text reads: `process.env.X`, `os.environ["X"]`, `os.getenv("X")`, `$X`. */
export function secretsRead(text: string): string[] {
  const out = new Set<string>()
  const name = "([A-Z][A-Z0-9_]*_(?:API_KEY|KEY|TOKEN|SECRET))\\b"
  for (const re of [new RegExp(`process\\.env\\.${name}`, "g"), new RegExp(`os\\.(?:environ\\[|getenv\\()["']${name}`, "g"), new RegExp(`\\$\\{?${name}`, "g"), new RegExp(`^\\s*(?:export\\s+)?${name}=`, "gm")]) {
    for (const m of text.matchAll(re)) out.add(m[1]!)
  }
  return [...out]
}

async function findSkillFolder(root: string, skillId: string): Promise<string | undefined> {
  const candidates: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (e.name === "SKILL.md") candidates.push(dir)
    }
  }
  await walk(root, 0)
  const byDir = candidates.find((d) => path.basename(d) === skillId)
  if (byDir) return byDir
  for (const d of candidates) {
    const { data } = parseFrontmatter(await readText(path.join(d, "SKILL.md")))
    if (data.name === skillId) return d
  }
  return undefined
}

async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)))
    else out.push(r)
  }
  return out.sort()
}

/** Copies the reviewed folder into `.slate/installed/skills/<id>/` and records it. */
export async function installSkill(root: string, skill: FetchedSkill, id = skill.id): Promise<string> {
  const dest = path.join(installedDir(root), "skills", id)
  await rm(dest, { recursive: true, force: true })
  await cp(skill.dir, dest, { recursive: true })
  await recordLock(root, { kind: "skill", id, source: skill.source, version: skill.commit, path: skill.path, ...(skill.envFound.length ? { env: skill.envFound } : {}), installed: new Date().toISOString() })
  return dest
}

/* ---------------------------------------------------------------------------- tools */

/** A kebab id for a registry name: io.github.mindstone/mcp-server-elevenlabs -> elevenlabs */
export function toolId(name: string): string {
  const last = name.split("/").pop() ?? name
  const id = last.toLowerCase().replace(/^(mcp[-_]server[-_]|server[-_]mcp[-_]|mcp[-_])/, "").replace(/([-_]mcp|[-_]mcp[-_]server)$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return id || "tool"
}

/** Writes `.slate/installed/capabilities/<id>.yml`: its MCP server, and the handshake as its check. */
export async function installTool(root: string, tool: ToolHit, id = toolId(tool.name)): Promise<string> {
  const file = path.join(installedDir(root), "capabilities", `${id}.yml`)
  const doc = {
    description: tool.description || tool.name,
    // No `check`: Slate runs the MCP handshake (initialize + tools/list) as its free check.
    install: tool.env.length ? `set ${tool.env.join(", ")} (environment or the project's .env)` : "",
    env: tool.env,
    mcp: { command: tool.command },
  }
  await writeText(file, `# Installed by \`slate skill\` from the MCP Registry: ${tool.name}@${tool.version}${tool.repository ? `\n# Source: ${tool.repository}` : ""}\n${YAML.stringify(doc)}`)
  await recordLock(root, { kind: "tool", id, source: tool.name, version: tool.version, installed: new Date().toISOString() })
  return file
}

/* ----------------------------------------------------------------------------- lock */

async function recordLock(root: string, entry: LockEntry): Promise<void> {
  const list = (await readLock(root)).filter((e) => !(e.kind === entry.kind && e.id === entry.id))
  list.push(entry)
  await writeText(path.join(installedDir(root), "lock.yaml"), `# What this project installed with \`slate skill\`; commit it with the project.\n${YAML.stringify({ installed: list })}`)
}

export async function removeInstalled(root: string, id: string): Promise<LockEntry | undefined> {
  const list = await readLock(root)
  const entry = list.find((e) => e.id === id)
  if (!entry) return undefined
  await rm(entry.kind === "skill" ? path.join(installedDir(root), "skills", id) : path.join(installedDir(root), "capabilities", `${id}.yml`), { recursive: true, force: true })
  await writeText(path.join(installedDir(root), "lock.yaml"), `# What this project installed with \`slate skill\`; commit it with the project.\n${YAML.stringify({ installed: list.filter((e) => e !== entry) })}`)
  return entry
}

/* ---------------------------------------------------------------------------- needs */

/**
 * Points a need in the needs file at what was installed (`skill:` or `capability:`), keeping the
 * file's comments and the other needs as they are. Adds the need when it is not listed.
 */
export async function mapNeed(root: string, needsFile: string, needId: string, target: { skill?: string; capability?: string }, what?: string): Promise<void> {
  const file = path.join(root, needsFile)
  const doc = (await isFile(file)) ? YAML.parseDocument(await readText(file)) : new YAML.Document({ needs: [] })
  let needs = doc.get("needs") as YAML.YAMLSeq | undefined
  if (!YAML.isSeq(needs)) {
    doc.set("needs", doc.createNode([]))
    needs = doc.get("needs") as YAML.YAMLSeq
  }
  let item = needs.items.find((n) => YAML.isMap(n) && n.get("id") === needId) as YAML.YAMLMap | undefined
  if (!item) {
    item = doc.createNode({ id: needId, ...(what ? { for: what } : {}) }) as YAML.YAMLMap
    needs.items.push(item)
  }
  item.delete("skill")
  item.delete("capability")
  if (target.skill) item.set("skill", target.skill)
  if (target.capability) item.set("capability", target.capability)
  await writeText(file, doc.toString())
}
