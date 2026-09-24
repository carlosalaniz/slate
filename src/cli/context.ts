import path from "node:path"
import { projectPaths, type ProjectPaths } from "../config/paths.ts"
import { loadProjectConfig, type ProjectConfig } from "../config/project.ts"
import { StateStore } from "../engine/state.ts"
import type { JobState } from "../engine/types.ts"
import { CliError } from "./output.ts"

export interface ProjectCtx {
  root: string
  paths: ProjectPaths
  config: ProjectConfig
}

export async function requireProject(cwd = process.cwd()): Promise<ProjectCtx> {
  const root = findRoot(cwd)
  if (!root) throw new CliError("no Slate project here", "run `slate init` first")
  const config = await loadProjectConfig(root)
  if (!config) throw new CliError("no Slate project here", "run `slate init` first")
  return { root, paths: projectPaths(root), config }
}

export async function requireJob(cwd = process.cwd()): Promise<ProjectCtx & { state: JobState }> {
  const p = await requireProject(cwd)
  const state = await StateStore.read(p.paths.state)
  if (!state) throw new CliError("no job exists", "run `slate start` to begin one")
  return { ...p, state }
}

function findRoot(cwd: string): string | undefined {
  let dir = path.resolve(cwd)
  while (true) {
    if (Bun.file(path.join(dir, "slate.config.yml")).size > 0 || fileExists(path.join(dir, "slate.config.yml"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function fileExists(p: string): boolean {
  try {
    return require("node:fs").existsSync(p)
  } catch {
    return false
  }
}

export async function isEngineAlive(paths: ProjectPaths): Promise<number | undefined> {
  const text = await Bun.file(paths.pid).text().catch(() => "")
  const pid = Number(text.trim())
  if (!pid) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}
