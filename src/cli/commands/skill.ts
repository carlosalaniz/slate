import path from "node:path"
import { register, runCommand } from "../main.ts"
import { parseArgs, str, bool } from "../args.ts"
import { CliError, type Output } from "../output.ts"
import { requireProject, type ProjectCtx } from "../context.ts"
import { select, spin } from "../prompt.ts"
import { projectPack } from "./check.ts"
import { loadCorePack } from "../../engine/core-pack.ts"
import { projectEnv, readNeeds, uncoveredNeeds, writeCatalog, type Need } from "../../engine/capabilities.ts"
import { loadPack, readLock } from "../../pack/loader.ts"
import type { LoadedPack } from "../../engine/types.ts"
import { fetchSkill, installSkill, installTool, mapNeed, removeInstalled, searchSkills, searchTools, toolId, type FetchedSkill, type Hit, type SkillHit, type ToolHit } from "../../marketplace/marketplace.ts"

/**
 * `slate skill` — when the product needs something nothing installed covers, find it in a
 * marketplace instead of writing it: skills from skills.sh, tools (MCP servers) from the MCP
 * Registry. You pick and review; Slate installs it into `.slate/installed/` at a pinned version,
 * maps the need to it in the needs file and runs `slate check`.
 */

const NEEDS_FALLBACK = "specs/capabilities.yaml"

register(
  "skill",
  `slate skill find [words...] [--need <id>] [--json]
slate skill show <owner/repo> <skill> | --tool <registry name> [--json]
slate skill add <owner/repo> <skill> [--need <id>] [--as <id>] [--yes]
slate skill add --tool <registry name> [--need <id>] [--as <id>] [--yes]
slate skill list | remove <id>

Finds what the product needs in a marketplace, so nobody writes it: skills (SKILL.md folders) from skills.sh
and tools (local MCP servers from npm or PyPI) from the official MCP Registry (slate.config.yml marketplace:
changes where). \`find\` with no words searches for the first need in specs/capabilities.yaml that nothing covers.
You pick one and read what it contains (every script it ships, the command a tool runs, the keys it needs)
before anything is installed. Slate then copies it into .slate/installed/ at a pinned commit or version
(recorded in lock.yaml; commit it with the project), maps the need to it, and runs \`slate check\`.
Nothing installed runs until a job uses it. --yes skips the review (only after reading it yourself).
\`show\` prints that review without installing: what discovery shows you before you decide.`,
  async (argv, out) => {
    const { positional, flags } = parseArgs(["skill", ...argv])
    const sub = positional[0]
    const p = await requireProject()
    if (sub === "find") return find(p, positional.slice(1).join(" "), flags, out)
    if (sub === "add") return add(p, positional.slice(1), flags, out)
    if (sub === "show") return show(p, positional.slice(1), flags, out)
    if (sub === "list") return list(p, out)
    if (sub === "remove") return remove(p, positional[1], out)
    throw new CliError(`unknown subcommand '${sub ?? ""}'`, "slate skill find | add | list | remove (see slate skill --help)")
  },
)

async function context(p: ProjectCtx): Promise<{ pack?: LoadedPack; needsFile?: string; needs: Need[]; uncovered: Need[] }> {
  const found = await projectPack(p).catch(() => undefined)
  const needsFile = found?.pack.manifest.needs ?? NEEDS_FALLBACK
  const read = await readNeeds(p.root, needsFile)
  const needs = "needs" in read ? read.needs : []
  if (!found) return { needsFile, needs, uncovered: needs.filter((n) => !n.skill && !n.capability) }
  const gaps = await uncoveredNeeds({ root: p.root, project: p.config, core: await loadCorePack() }, found.pack)
  const uncovered = needs.filter((n) => gaps.some((g) => g.includes(`need '${n.id}'`)))
  return { pack: found.pack, needsFile, needs, uncovered }
}

async function find(p: ProjectCtx, words: string, flags: Record<string, string | boolean>, out: Output): Promise<number> {
  const ctx = await context(p)
  let need = str(flags, "need") ? ctx.needs.find((n) => n.id === str(flags, "need")) ?? { id: str(flags, "need")! } : undefined
  if (!words && !need) {
    if (!ctx.uncovered.length) throw new CliError("nothing to search for", `give some words (slate skill find text to speech), or --need <id>; ${ctx.needsFile} has no uncovered need`)
    need = ctx.uncovered.length === 1 || out.json || !process.stdin.isTTY ? ctx.uncovered[0]! : await pickNeed(ctx.uncovered)
  }
  const query = words || need?.for || need!.id
  const phrases = unique(words ? [words] : [need!.for, need!.id.replace(/-/g, " "), need!.id].filter((x): x is string => Boolean(x)))
  const words_ = keywords(phrases)
  const search = Promise.all([
    searchMany([...phrases, ...words_], (q) => searchSkills(p.config.marketplace.skills, q), (h) => `${h.source}/${h.skillId}`)
      .then((hits) => rank(collapseCopies(hits), words_, (h) => `${h.source} ${h.skillId}`, (h) => h.installs).slice(0, 8))
      .catch((e: Error) => (out.err(`skills: ${e.message}`), [])),
    // The registry matches names, so it is asked one keyword at a time.
    searchMany(words_, (q) => searchTools(p.config.marketplace.tools, q, 20), (h) => h.name)
      .then((hits) => rank(hits, words_, (h) => `${h.name} ${h.description}`, () => 0).slice(0, 5))
      .catch((e: Error) => (out.err(`tools: ${e.message}`), [])),
  ])
  const [skills, tools] = out.json ? await search : await spin(`searching skills.sh and the MCP Registry for "${query}"…`, search)
  const hits: Hit[] = [...skills, ...tools]
  if (out.json || !process.stdin.isTTY) {
    out.emit(() => [`results for "${query}"${need ? ` (need ${need.id})` : ""}:`, ...hits.map(describe), "install one with `slate skill add`"], { query, need: need?.id ?? null, skills, tools })
    return 0
  }
  if (!hits.length) {
    out.line(`nothing found for "${query}"; try other words: slate skill find <words>${need ? ` --need ${need.id}` : ""}`)
    return 1
  }
  const choice = await select(
    `pick one for ${need ? `need '${need.id}'` : `"${query}"`}`,
    [...hits.map((h, i) => ({ value: String(i), label: label(h), hint: hint(h) })), { value: "none", label: "none of these" }],
    "0",
    { pageSize: 12 },
  )
  if (choice === "none") return 1
  const hit = hits[Number(choice)]!
  return hit.kind === "skill" ? installSkillFlow(p, ctx, hit.source, hit.skillId, need, undefined, false, out) : installToolFlow(p, ctx, hit, need, undefined, false, out)
}

/** Asks every phrase (side by side), keeping each distinct result with how many phrases found it. */
async function searchMany<T>(phrases: string[], search: (q: string) => Promise<T[]>, key: (h: T) => string): Promise<(T & { found: number })[]> {
  const out = new Map<string, T & { found: number }>()
  for (const hits of await Promise.all(phrases.map((q) => search(q).catch(() => [] as T[])))) {
    for (const h of hits) {
      const k = key(h)
      const seen = out.get(k)
      if (seen) seen.found++
      else out.set(k, { ...h, found: 1 })
    }
  }
  return [...out.values()]
}

/** Forks republish popular skills under the same id; keep the one most installed and say how many copies there are. */
function collapseCopies<T extends SkillHit & { found: number }>(hits: T[]): (T & { copies: number })[] {
  const by = new Map<string, T & { copies: number }>()
  for (const h of hits) {
    const seen = by.get(h.skillId)
    if (!seen) by.set(h.skillId, { ...h, copies: 0 })
    else {
      const best = h.installs > seen.installs ? { ...h, copies: seen.copies + 1, found: Math.max(h.found, seen.found) } : { ...seen, copies: seen.copies + 1 }
      by.set(h.skillId, best)
    }
  }
  return [...by.values()]
}

/** Most of the need's words in its name first, then found by more searches, then most installed. */
function rank<T extends { found: number }>(hits: T[], words: string[], text: (h: T) => string, installs: (h: T) => number): T[] {
  const score = (h: T) => {
    const t = text(h).toLowerCase()
    return words.filter((w) => t.includes(w)).length * 10 + h.found * 2 + Math.log10(1 + installs(h))
  }
  return [...hits].sort((a, b) => score(b) - score(a))
}

const STOP = new Set(["with", "from", "that", "this", "into", "using", "for", "the", "and", "time", "build", "generated", "generate", "clips", "files", "each", "every", "some", "make", "made", "real"])

/** The words worth searching names for, longest first. */
function keywords(phrases: string[]): string[] {
  const words = phrases.flatMap((p) => p.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 4 && !STOP.has(w))
  return unique(words).sort((a, b) => b.length - a.length).slice(0, 4)
}

function unique(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

async function pickNeed(needs: Need[]): Promise<Need> {
  const id = await select(
    "which need?",
    needs.map((n) => ({ value: n.id, label: n.id, hint: n.for ?? "" })),
    needs[0]!.id,
  )
  return needs.find((n) => n.id === id)!
}

async function add(p: ProjectCtx, args: string[], flags: Record<string, string | boolean>, out: Output): Promise<number> {
  const ctx = await context(p)
  const needId = str(flags, "need")
  const need = needId ? (ctx.needs.find((n) => n.id === needId) ?? { id: needId }) : undefined
  const yes = bool(flags, "yes", "y")
  const tool = str(flags, "tool")
  if (tool) {
    const found = (await searchTools(p.config.marketplace.tools, tool, 20)).find((t) => t.name === tool)
    if (!found) throw new CliError(`no local (npm or PyPI) MCP server named '${tool}' in the registry`, "slate skill find <words> lists what there is")
    return installToolFlow(p, ctx, found, need, str(flags, "as"), yes, out)
  }
  const [source, skillId] = args
  if (!source || !skillId) throw new CliError("give the repository and the skill", "slate skill add elevenlabs/skills text-to-speech --need audio-synthesis")
  return installSkillFlow(p, ctx, source, skillId, need, str(flags, "as"), yes, out)
}

/** The review of one skill or tool, without installing it. */
async function show(p: ProjectCtx, args: string[], flags: Record<string, string | boolean>, out: Output): Promise<number> {
  const env = projectEnv(p.root)
  const tool = str(flags, "tool")
  if (tool) {
    const found = (await searchTools(p.config.marketplace.tools, tool, 20)).find((t) => t.name === tool)
    if (!found) throw new CliError(`no local (npm or PyPI) MCP server named '${tool}' in the registry`, "slate skill find <words> lists what there is")
    const missing = found.env.filter((k) => env[k] === undefined)
    out.emit(() => toolReview(found, toolId(found.name), env), { kind: "tool", id: toolId(found.name), name: found.name, version: found.version, description: found.description, runs: found.command, env: found.env, missingEnv: missing, variables: found.envNotes, repository: found.repository ?? null })
    return 0
  }
  const [source, skillId] = args
  if (!source || !skillId) throw new CliError("give the repository and the skill", "slate skill show elevenlabs/skills text-to-speech")
  const skill = out.json ? await fetchSkill(source, skillId) : await spin(`fetching ${source} › ${skillId}…`, fetchSkill(source, skillId))
  try {
    const keys = [...skill.env, ...skill.envFound]
    out.emit(() => skillReview(skill, env), {
      kind: "skill",
      id: skill.id,
      source: skill.source,
      commit: skill.commit,
      path: skill.path,
      description: skill.description,
      compatibility: skill.compatibility ?? null,
      service: skill.service ?? null,
      setup: skill.setup,
      env: keys,
      missingEnv: keys.filter((k) => env[k] === undefined),
      files: skill.files,
      scripts: skill.scripts,
      skillMd: skill.skillMd.split("\n").slice(0, 40).join("\n"),
    })
    return 0
  } finally {
    await skill.dispose()
  }
}

function skillReview(skill: FetchedSkill, env: Record<string, string>): string[] {
  const state = (k: string) => `${k} (${env[k] !== undefined ? "set" : "not set"})`
  return [
    "",
    `skill ${skill.id} from ${skill.source} @ ${skill.commit.slice(0, 12)} (${skill.path || "repository root"})`,
    `  ${skill.description}`,
    ...(skill.service ? [`  works through: ${skill.service} (an outside service: its account, and its prices)`] : []),
    ...(skill.setup.length ? [`  setup it asks for: ${skill.setup.join("; ")}`] : []),
    ...(skill.compatibility ? [`  compatibility: ${skill.compatibility}`] : []),
    ...(skill.env.length ? [`  needs: ${skill.env.map(state).join(", ")}`] : []),
    ...(skill.envFound.length ? [`  reads (found in its text; Slate will check them): ${skill.envFound.map(state).join(", ")}`] : []),
    `  files: ${skill.files.join(", ")}`,
    skill.scripts.length ? `  scripts it ships (agents may run them): ${skill.scripts.join(", ")}` : "  scripts it ships: none",
    "  ─── SKILL.md (first lines) ───",
    ...skill.skillMd.split("\n").slice(0, 24).map((l) => `  │ ${l}`),
    "",
  ]
}

function toolReview(tool: ToolHit, id: string, env: Record<string, string>): string[] {
  return [
    "",
    `tool ${id}: ${tool.name}@${tool.version}${tool.repository ? ` (${tool.repository})` : ""}`,
    `  ${tool.description}`,
    `  runs: ${tool.command.join(" ")}`,
    ...(tool.envNotes.length ? ["  variables:", ...tool.envNotes.map((n) => `    ${n}${env[n.split(" ")[0]!.replace(/:$/, "")] !== undefined ? " [set]" : ""}`)] : []),
    "  only agents and skills that require it may call its tools; its check is the MCP handshake (free)",
    "",
  ]
}

/** Nothing is installed before the person has seen what it contains, unless they said --yes. */
async function confirm(out: Output, yes: boolean, lines: string[]): Promise<boolean> {
  out.line(lines.join("\n"))
  if (yes) return true
  if (!process.stdin.isTTY || out.json) throw new CliError("installing needs your review", "read the above, then run the same command with --yes")
  return (await select("install it into this project?", [{ value: "install" }, { value: "cancel" }], "install")) === "install"
}

async function installSkillFlow(p: ProjectCtx, ctx: Awaited<ReturnType<typeof context>>, source: string, skillId: string, need: Need | undefined, as: string | undefined, yes: boolean, out: Output): Promise<number> {
  const id = as ?? skillId
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CliError(`'${id}' is not a usable skill id`, "pass --as <kebab-case-id>")
  if (ctx.pack?.skills[id] && !ctx.pack.skills[id]!.source) throw new CliError(`the pack already has a skill '${id}'`, "install it under another name with --as <id>")
  const skill: FetchedSkill = out.json ? await fetchSkill(source, skillId) : await spin(`fetching ${source} › ${skillId}…`, fetchSkill(source, skillId))
  try {
    if (!(await confirm(out, yes, skillReview(skill, projectEnv(p.root))))) return 1
    const dest = await installSkill(p.root, skill, id)
    return finish(p, ctx, { skill: id }, need, `installed skill ${id} into ${path.relative(p.root, dest)}`, [...skill.env, ...skill.envFound], out)
  } finally {
    await skill.dispose()
  }
}

async function installToolFlow(p: ProjectCtx, ctx: Awaited<ReturnType<typeof context>>, tool: ToolHit, need: Need | undefined, as: string | undefined, yes: boolean, out: Output): Promise<number> {
  const id = as ?? toolId(tool.name)
  if (ctx.pack?.capabilities[id] && !(await readLock(p.root)).some((e) => e.kind === "tool" && e.id === id)) throw new CliError(`a tool '${id}' already exists`, "install it under another name with --as <id>")
  if (!(await confirm(out, yes, toolReview(tool, id, projectEnv(p.root))))) return 1
  const file = await installTool(p.root, tool, id)
  return finish(p, ctx, { capability: id }, need, `installed tool ${id} into ${path.relative(p.root, file)}`, tool.env, out)
}

async function finish(p: ProjectCtx, ctx: Awaited<ReturnType<typeof context>>, target: { skill?: string; capability?: string }, need: Need | undefined, done: string, env: string[], out: Output): Promise<number> {
  const lines = [done]
  if (need && ctx.needsFile) {
    await mapNeed(p.root, ctx.needsFile, need.id, target, need.for)
    lines.push(`need '${need.id}' in ${ctx.needsFile} now uses it`)
  }
  // Discovery's specialists map needs to what is installed: refresh their list.
  if (ctx.pack) await writeCatalog(p.root, await loadPack(ctx.pack.dir, p.config.config, { projectRoot: p.root }), await loadCorePack())
  const values = projectEnv(p.root)
  const missing = env.filter((k) => values[k] === undefined)
  if (missing.length) lines.push(`set ${missing.join(", ")} (export it, or add it to the project's .env and keep .env out of git)`)
  out.emit(() => lines, { installed: target, need: need?.id ?? null, missingEnv: missing })
  if (!ctx.pack || out.json) return 0
  out.line("")
  return runCommand("check", [], out)
}

async function list(p: ProjectCtx, out: Output): Promise<number> {
  const lock = await readLock(p.root)
  out.emit(() => (lock.length ? lock.map((e) => `${e.kind.padEnd(5)} ${e.id.padEnd(24)} ${e.source}${e.path ? `/${e.path}` : ""} @ ${e.kind === "skill" ? e.version.slice(0, 12) : e.version}`) : ["nothing installed (slate skill find)"]), { installed: lock })
  return 0
}

async function remove(p: ProjectCtx, id: string | undefined, out: Output): Promise<number> {
  if (!id) throw new CliError("give the id to remove", "slate skill list shows them")
  const entry = await removeInstalled(p.root, id)
  if (!entry) throw new CliError(`nothing installed as '${id}'`, "slate skill list shows what is")
  out.emit(() => [`removed ${entry.kind} ${id}`, "needs that used it are uncovered again; slate check says which"], { removed: entry })
  return 0
}

function label(h: Hit): string {
  return h.kind === "skill" ? `skill  ${h.source} › ${h.skillId}` : `tool   ${h.name}`
}

function hint(h: Hit): string {
  const copies = (h as { copies?: number }).copies
  return h.kind === "skill" ? `${h.installs.toLocaleString("en-US")} installs${copies ? ` · ${copies} other cop${copies === 1 ? "y" : "ies"} elsewhere` : ""}` : `${h.command[0] === "npx" ? "npm" : "PyPI"} ${h.version}${h.env.length ? ` · needs ${h.env.join(", ")}` : ""}`
}

function describe(h: Hit): string {
  return `  ${label(h)}  (${hint(h)})`
}
