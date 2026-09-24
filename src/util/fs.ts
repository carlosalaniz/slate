import { mkdir, readFile, writeFile, rename, stat, readdir, rm, appendFile, copyFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export function exists(p: string): boolean {
  return existsSync(p)
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function readText(p: string): Promise<string> {
  return readFile(p, "utf8")
}

export async function readTextOr(p: string, fallback: string): Promise<string> {
  try {
    return await readFile(p, "utf8")
  } catch {
    return fallback
  }
}

/** Writes atomically: temp file in the same directory, then rename. */
export async function writeTextAtomic(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p))
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, p)
}

export async function writeText(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p))
  await writeFile(p, content, "utf8")
}

export async function appendText(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p))
  await appendFile(p, content, "utf8")
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T
}

export async function readJsonOr<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(p: string, value: unknown): Promise<void> {
  await writeTextAtomic(p, JSON.stringify(value, null, 2) + "\n")
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

export async function removePath(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true })
}

/** Copies a tree, skipping node_modules, .git and .slate, and never descending into the destination. */
export async function copyDir(src: string, dest: string, ignore: string[] = ["node_modules", ".git", ".slate"]): Promise<void> {
  await ensureDir(dest)
  const destAbs = path.resolve(dest)
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      if (ignore.includes(entry.name) || path.resolve(s) === destAbs || destAbs.startsWith(path.resolve(s) + path.sep)) continue
      await copyDir(s, d, ignore)
    } else if (entry.isFile()) {
      await copyFile(s, d)
    }
  }
}

/** Recursively lists files under dir, returning paths relative to dir with forward slashes. */
export async function walkFiles(dir: string, ignore: string[] = ["node_modules", ".git", ".slate"]): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string, rel: string) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (ignore.includes(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(path.join(current, e.name), r)
      else if (e.isFile()) out.push(r)
    }
  }
  await walk(dir, "")
  return out.sort()
}
