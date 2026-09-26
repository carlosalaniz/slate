/**
 * Shared helpers for this pack's scripts. Every script follows Slate's script contract:
 * print exactly one JSON object on stdout and exit 0. Exiting nonzero means the script itself
 * is broken, which stops the job (it is never a failed check).
 */
import fs from "node:fs"
import path from "node:path"

/** The directory the step runs in: the project root, or a story's worktree. */
export const workspace = process.env.SLATE_WORKSPACE ?? process.cwd()
/** The project root. A story running in its own worktree has workspace !== root. */
export const root = process.env.SLATE_VAR_WORKSPACE ?? workspace

/** Runs git in `cwd` (the workspace by default). */
export function git(args: string[], cwd = workspace): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}

/** The branch checked out in `cwd`; undefined outside git or on a detached HEAD. */
export function currentBranch(cwd = workspace): string | undefined {
  const r = git(["symbolic-ref", "--short", "HEAD"], cwd)
  return r.ok ? r.out : undefined
}

/** Files with unresolved merge conflicts in `cwd`. */
export function conflictedFiles(cwd = workspace): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"], cwd).out.split("\n").filter(Boolean)
}

export interface Story {
  id: string | number
  title?: string
  description?: string
  acceptance?: string[]
  depends_on?: (string | number)[]
  /** Paths of the screens the story adds or changes (e.g. "/settings"): a UX review looks at them once it lands. */
  screens?: string[]
  /** A fix story filed by a UX review: the story whose screens were reviewed, and that review's pass. */
  ux_of?: string
  ux_pass?: number
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
  /** Files the task owns: `modify` for existing ones; `create` (new files) is accepted as the same thing. */
  scope?: { modify?: string[]; create?: string[] }
}
export interface TaskList {
  tasks?: Task[]
}

/**
 * Reads a YAML file relative to the workspace; undefined when it does not exist. A file that does
 * not parse stops the job with a one-line reason (an iterator cannot go on without it); checks use
 * `checkYaml` instead.
 */
export function readYaml<T>(relativePath: string): T | undefined {
  const parsed = parseYaml<T>(relativePath)
  return "error" in parsed ? broken(`${relativePath} is not valid YAML: ${parsed.error}`) : parsed.value
}

/** Like readYaml, for checks: a file that does not parse is a failed check, not a broken script. */
export function checkYaml<T>(relativePath: string): T | undefined {
  const parsed = parseYaml<T>(relativePath)
  return "error" in parsed ? reply({ ok: false, reason: `${relativePath} is not valid YAML: ${parsed.error}` }) : parsed.value
}

function parseYaml<T>(relativePath: string): { value: T | undefined } | { error: string } {
  const file = path.join(workspace, relativePath)
  if (!fs.existsSync(file)) return { value: undefined }
  try {
    return { value: (Bun.YAML.parse(fs.readFileSync(file, "utf8")) ?? undefined) as T | undefined }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(workspace, relativePath))
}

/** Every file or glob a task owns, whether it is listed under scope.modify or scope.create. */
export function taskScope(task: Task): string[] {
  return [...(task.scope?.modify ?? []), ...(task.scope?.create ?? [])].map(String)
}

/** Items this over-loop has already handed out (Slate passes them in SLATE_CLAIMED). */
export function claimedItems(): Set<string> {
  return new Set(JSON.parse(process.env.SLATE_CLAIMED ?? "[]") as string[])
}

/**
 * Commits the story's report (stories/<story>/merged.md) if it is written but not committed. The
 * integrator is asked to commit it; when it does not, the story must not wedge on a dirty worktree.
 */
export function commitStoryReport(story: string, cwd = workspace): void {
  const rel = `stories/${story}/merged.md`
  if (!fs.existsSync(path.join(cwd, rel))) return
  if (!git(["status", "--porcelain", "--", rel], cwd).out) return
  git(["add", "--", rel], cwd)
  git(["commit", "-m", `${story}: done`, "--", rel], cwd)
}

/** Ids Slate was told to go without (slate.config.yml capabilities.waive). */
export function waived(): Set<string> {
  return new Set((process.env.SLATE_VAR_WAIVED ?? "").split(",").map((s) => s.trim()).filter(Boolean))
}

/**
 * Serializes changes to the project's branch (landing a story, filing a UX fix story):
 * mkdir is atomic, so whoever creates the lock directory goes; a lock left by a dead process is taken over.
 */
export async function withProjectLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = path.join(root, ".slate", "land.lock")
  const deadline = Date.now() + 10 * 60_000
  while (true) {
    try {
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid))
      break
    } catch {
      const owner = lockOwner(dir)
      if (owner && !alive(owner)) fs.rmSync(dir, { recursive: true, force: true })
      else if (Date.now() > deadline) broken(`waited 10 minutes for ${dir}; remove it if no story is landing`)
      else await Bun.sleep(250)
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function lockOwner(dir: string): number {
  try {
    return Number(fs.readFileSync(path.join(dir, "pid"), "utf8")) || 0
  } catch {
    return 0
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
