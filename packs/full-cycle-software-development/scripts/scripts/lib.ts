/**
 * Shared helpers for this pack's scripts. Every script follows Slate's script contract:
 * print exactly one JSON object on stdout and exit 0. Exiting nonzero means the script itself
 * is broken, which stops the job (it is never a failed check).
 */
import fs from "node:fs"
import path from "node:path"

/** The directory the step runs in: the project root, or a task's worktree. */
export const workspace = process.env.SLATE_WORKSPACE ?? process.cwd()

export interface Story {
  id: string | number
  title?: string
  depends_on?: (string | number)[]
}
export interface StoryIndex {
  stories?: Story[]
}
export interface StoryGraph {
  nodes?: Record<string, (string | number)[] | null>
}
export interface Task {
  id: string | number
  title?: string
  scope?: { modify?: string[] }
}
export interface TaskList {
  tasks?: Task[]
}

/** Reads a YAML file relative to the workspace; undefined when it does not exist. */
export function readYaml<T>(relativePath: string): T | undefined {
  const file = path.join(workspace, relativePath)
  if (!fs.existsSync(file)) return undefined
  return (Bun.YAML.parse(fs.readFileSync(file, "utf8")) ?? undefined) as T | undefined
}

export function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(workspace, relativePath))
}

/** Items this over-loop has already handed out (Slate passes them in SLATE_CLAIMED). */
export function claimedItems(): Set<string> {
  return new Set(JSON.parse(process.env.SLATE_CLAIMED ?? "[]") as string[])
}

/** Prints the script's answer and exits 0. */
export function reply(answer: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(answer) + "\n")
  process.exit(0)
}

/** The script cannot do its job (missing input, bad usage): exit nonzero so Slate stops the job. */
export function broken(message: string): never {
  console.error(message)
  process.exit(2)
}
