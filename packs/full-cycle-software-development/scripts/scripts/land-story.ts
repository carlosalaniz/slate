/**
 * Lands a closed story: merges its branch into the project's current branch, in the project root.
 * Stories run in parallel, so landing takes a lock (.slate/land.lock) and merges one at a time.
 * A conflict (another story landed first and touched the same lines) aborts the merge and fails
 * the check: the next close round merges that story in and the integrator resolves it there. A
 * story that ran in the project itself is already on the branch.
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, root, reply, broken, git, currentBranch, conflictedFiles } from "./lib.ts"

const story = process.argv[2] ?? process.env.SLATE_VAR_STORY
if (!story) broken("usage: land-story <story>")
if (workspace === root) reply({ ok: true, note: "runs in the project itself" })

const branch = currentBranch()
const base = currentBranch(root)
if (!branch || !base) broken(`land-story needs both the story (${workspace}) and the project on a branch`)
if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok || conflictedFiles().length) {
  reply({ ok: false, reason: `the merge of ${base} into ${branch} is still unresolved (${conflictedFiles().join(", ") || "merge in progress"})` })
}
const dirty = git(["status", "--porcelain"]).out
if (dirty) reply({ ok: false, reason: `the story's worktree has uncommitted changes; commit them before it lands:\n${dirty.slice(0, 500)}` })
if (!fs.existsSync(path.join(workspace, "stories", story, "merged.md"))) reply({ ok: false, reason: `stories/${story}/merged.md is missing` })

const lock = path.join(root, ".slate", "land.lock")
await acquire(lock)
// reply() exits the process, so the lock is released before answering.
let answer: Record<string, unknown>
const merge = git(["merge", "--no-ff", "--no-edit", "-m", `Merge story ${story}`, branch], root)
if (merge.ok) {
  answer = { ok: true, landed: branch, on: base, commit: git(["rev-parse", "--short", "HEAD"], root).out }
} else {
  const conflicts = conflictedFiles(root)
  git(["merge", "--abort"], root)
  const why = conflicts.length ? `landing ${branch} on ${base} conflicts in ${conflicts.join(", ")}; the next round merges ${base} into the story first` : `git merge failed: ${merge.err || merge.out}`
  answer = { ok: false, reason: why.slice(0, 800) }
}
fs.rmSync(lock, { recursive: true, force: true })
reply(answer)

/** mkdir is atomic: the story that creates the lock directory lands; the others wait. A lock left by a dead process is taken over. */
async function acquire(dir: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000
  while (true) {
    try {
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid))
      return
    } catch {
      const owner = lockOwner(dir)
      if (owner && !alive(owner)) fs.rmSync(dir, { recursive: true, force: true })
      else if (Date.now() > deadline) broken(`waited 10 minutes for ${dir}; remove it if no story is landing`)
      else await Bun.sleep(250)
    }
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
