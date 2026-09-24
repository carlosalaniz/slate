import path from "node:path"
import { bundledPacksDir, userPacksDir, projectPaths } from "../config/paths.ts"
import { isDir, isFile, listDir, copyDir, writeText, readTextOr, removePath } from "../util/fs.ts"
import { loadPack, PackError } from "./loader.ts"
import type { LoadedPack } from "../engine/types.ts"

export interface InstalledPack {
  name: string
  version: string
  dir: string
  source: "bundled" | "user" | "project"
  description: string
  fits: string
  origin?: string
}

async function scan(dir: string, source: InstalledPack["source"]): Promise<InstalledPack[]> {
  const out: InstalledPack[] = []
  if (!(await isDir(dir))) return out
  for (const entry of await listDir(dir)) {
    const packDir = path.join(dir, entry)
    if (!(await isFile(path.join(packDir, "slate-pack.yml")))) continue
    try {
      const pack = await loadPack(packDir)
      const origin = (await readTextOr(path.join(packDir, ".slate-origin"), "")).trim() || undefined
      out.push({ name: pack.manifest.name, version: pack.manifest.version, dir: packDir, source, description: pack.manifest.description, fits: pack.manifest.fits, origin })
    } catch (e) {
      out.push({ name: entry, version: "invalid", dir: packDir, source, description: `INVALID: ${(e as Error).message.split("\n")[0]}`, fits: "" })
    }
  }
  return out
}

/** Slate's own bundled pack. It is loaded for every job and is never offered as a workflow. */
export const CORE_PACK_NAME = "slate-core"

/** Project packs shadow user packs, which shadow bundled packs. slate-core is never listed. */
export async function listInstalledPacks(root?: string): Promise<InstalledPack[]> {
  const all = [
    ...(root ? await scan(projectPaths(root).packs, "project") : []),
    ...(await scan(userPacksDir(), "user")),
    ...(await scan(bundledPacksDir(), "bundled")),
  ]
  const seen = new Map<string, InstalledPack>()
  for (const p of all) {
    if (p.name === CORE_PACK_NAME) continue
    const key = `${p.name}@${p.version}`
    if (!seen.has(key)) seen.set(key, p)
  }
  return [...seen.values()]
}

export async function findPack(ref: string, root?: string): Promise<InstalledPack | undefined> {
  if (ref.includes("/") || ref.startsWith(".")) {
    const dir = path.resolve(ref)
    if (await isFile(path.join(dir, "slate-pack.yml"))) {
      const pack = await loadPack(dir)
      return { name: pack.manifest.name, version: pack.manifest.version, dir, source: "project", description: pack.manifest.description, fits: pack.manifest.fits }
    }
    return undefined
  }
  const at = ref.lastIndexOf("@")
  const name = at > 0 ? ref.slice(0, at) : ref
  const version = at > 0 ? ref.slice(at + 1) : undefined
  const packs = (await listInstalledPacks(root)).filter((p) => p.name === name && p.version !== "invalid")
  if (version) return packs.find((p) => p.version === version)
  return packs.sort((a, b) => compareVersions(b.version, a.version))[0]
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === "number" && typeof y === "number") return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

export async function addPack(source: string, opts: { root?: string; scope: "user" | "project" }): Promise<InstalledPack> {
  const src = path.resolve(source)
  if (!(await isFile(path.join(src, "slate-pack.yml")))) throw new PackError([`${src}: slate-pack.yml not found`])
  const pack = await loadPack(src)
  const base = opts.scope === "project" ? projectPaths(opts.root ?? process.cwd()).packs : userPacksDir()
  const dest = path.join(base, `${pack.manifest.name}@${pack.manifest.version}`)
  await removePath(dest)
  await copyDir(src, dest)
  await writeText(path.join(dest, ".slate-origin"), src + "\n")
  return { name: pack.manifest.name, version: pack.manifest.version, dir: dest, source: opts.scope, description: pack.manifest.description, fits: pack.manifest.fits, origin: src }
}

export async function updatePack(ref: string, opts: { root?: string }): Promise<InstalledPack> {
  const installed = await findPack(ref, opts.root)
  if (!installed) throw new PackError([`pack '${ref}' is not installed`])
  if (!installed.origin) throw new PackError([`pack '${ref}' has no recorded origin (bundled packs update with Slate itself)`])
  if (!(await isDir(installed.origin))) throw new PackError([`origin ${installed.origin} no longer exists`])
  return addPack(installed.origin, { root: opts.root, scope: installed.source === "project" ? "project" : "user" })
}

export async function validatePackDir(dir: string): Promise<{ ok: true; pack: LoadedPack } | { ok: false; problems: string[] }> {
  try {
    const pack = await loadPack(path.resolve(dir))
    return { ok: true, pack }
  } catch (e) {
    if (e instanceof PackError) return { ok: false, problems: e.problems }
    return { ok: false, problems: [(e as Error).message] }
  }
}
