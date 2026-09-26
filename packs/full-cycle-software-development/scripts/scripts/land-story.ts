/**
 * Lands a closed story: merges its branch into the project's current branch, in the project root.
 * Stories run in parallel, so landing takes the project lock (.slate/land.lock) and merges one at a time.
 * A conflict (another story landed first and touched the same lines) aborts the merge and fails
 * the check: the next close round merges that story in and the integrator resolves it there. A
 * story that ran in the project itself is already on the branch.
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, root, reply, broken, git, currentBranch, conflictedFiles, withProjectLock, commitStoryReport } from "./lib.ts"

const story = process.argv[2] ?? process.env.SLATE_VAR_STORY
if (!story) broken("usage: land-story <story>")
if (workspace === root) reply({ ok: true, note: "runs in the project itself" })

const branch = currentBranch()
const base = currentBranch(root)
if (!branch || !base) broken(`land-story needs both the story (${workspace}) and the project on a branch`)
if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok || conflictedFiles().length) {
  reply({ ok: false, reason: `the merge of ${base} into ${branch} is still unresolved (${conflictedFiles().join(", ") || "merge in progress"})` })
}
commitStoryReport(story)
const dirty = git(["status", "--porcelain"]).out
if (dirty) reply({ ok: false, reason: `the story's worktree has uncommitted changes; commit them before it lands:\n${dirty.slice(0, 500)}` })
if (!fs.existsSync(path.join(workspace, "stories", story, "merged.md"))) reply({ ok: false, reason: `stories/${story}/merged.md is missing` })

// reply() exits the process, so the answer is given after the lock is released.
const answer = await withProjectLock(() => {
  const merge = git(["merge", "--no-ff", "--no-edit", "-m", `Merge story ${story}`, branch], root)
  if (merge.ok) return { ok: true, landed: branch, on: base, commit: git(["rev-parse", "--short", "HEAD"], root).out }
  const conflicts = conflictedFiles(root)
  git(["merge", "--abort"], root)
  const why = conflicts.length ? `landing ${branch} on ${base} conflicts in ${conflicts.join(", ")}; the next round merges ${base} into the story first` : `git merge failed: ${merge.err || merge.out}`
  return { ok: false, reason: why.slice(0, 800) }
})
reply(answer)
