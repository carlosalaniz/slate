import path from "node:path"
import YAML from "yaml"
import { bundledPacksDir } from "../config/paths.ts"
import { loadPack, PackError } from "../pack/loader.ts"
import { CORE_PACK_NAME, type InstalledPack } from "../pack/registry.ts"
import { isDir, isFile, listDir, readText } from "../util/fs.ts"
import type { CorePack } from "./types.ts"

/**
 * core-pack — Slate's own words, loaded from `packs/slate-core`.
 * Every text Slate sends a model (intake, pack choice, stuck-loop decisions, step framing,
 * re-prompts, consults, gates) is a file in that pack. Code here only loads and fills templates.
 */

export function corePackDir(): string {
  return path.join(bundledPacksDir(), CORE_PACK_NAME)
}

let cached: CorePack | undefined

/** Loads slate-core once per process. A missing or broken slate-core is an installation error. */
export async function loadCorePack(): Promise<CorePack> {
  if (cached) return cached
  const dir = corePackDir()
  let pack
  try {
    pack = await loadPack(dir)
  } catch (e) {
    const detail = e instanceof PackError ? e.problems.join("; ") : (e as Error).message
    throw new Error(`Slate's bundled pack ${dir} could not be loaded (${detail}). Reinstall Slate.`)
  }
  const prompts: Record<string, string> = {}
  const promptsDir = path.join(dir, "prompts")
  if (await isDir(promptsDir)) {
    for (const f of await listDir(promptsDir)) if (f.endsWith(".md")) prompts[f.slice(0, -3)] = await readText(path.join(promptsDir, f))
  }
  const messagesFile = path.join(promptsDir, "messages.yml")
  const messages = (await isFile(messagesFile)) ? ((YAML.parse(await readText(messagesFile)) ?? {}) as Record<string, string>) : {}
  cached = { ...pack, prompts, messages }
  return cached
}

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g

/**
 * Fills a `prompts/<name>.md` template. `{name}` takes the value from `vars`; a line whose
 * placeholders are all empty is dropped, so optional lines vanish without template logic.
 * Placeholders with no entry in `vars` are left as written.
 */
export function renderPrompt(core: CorePack, name: string, vars: Record<string, string | number | undefined>): string {
  const template = core.prompts[name]
  if (template === undefined) throw new Error(`slate-core has no prompts/${name}.md`)
  return fill(template, vars)
}

/** Fills a short text from slate-core `prompts/messages.yml`, with the same rules as renderPrompt. */
export function renderMessage(core: CorePack, key: string, vars: Record<string, string | number | undefined> = {}): string {
  const template = core.messages[key]
  if (template === undefined) throw new Error(`slate-core prompts/messages.yml has no '${key}'`)
  return fill(String(template), vars)
}

function fill(template: string, vars: Record<string, string | number | undefined>): string {
  const out: string[] = []
  for (const line of template.split("\n")) {
    const names = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => n in vars)
    if (names.length && names.every((n) => String(vars[n] ?? "") === "")) continue
    out.push(line.replace(PLACEHOLDER, (whole, n: string) => (n in vars ? String(vars[n] ?? "") : whole)))
  }
  return out.join("\n").trim()
}

/** Offline fallback when no model is available: keyword overlap between the brief and each pack's fits/description. */
export function proposePackOffline(brief: string, packs: InstalledPack[]): InstalledPack | undefined {
  const words = tokens(brief)
  let best: { pack: InstalledPack; score: number } | undefined
  for (const p of packs) {
    if (p.version === "invalid") continue
    const fit = tokens(`${p.fits} ${p.description} ${p.name}`)
    let score = 0
    for (const w of fit) if (words.has(w)) score++
    if (!best || score > best.score) best = { pack: p, score }
  }
  return best && best.score > 0 ? best.pack : packs.length === 1 ? packs[0] : undefined
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  )
}
const STOP = new Set(["with", "from", "that", "this", "into", "then", "than", "them", "they", "have", "will", "your", "when", "what", "which", "about", "their", "there", "these", "those", "would", "could", "should"])
