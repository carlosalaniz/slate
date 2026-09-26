/**
 * Before a story closes, brings in what other stories landed meanwhile: merges the project's
 * current branch into the story's branch, in the story's worktree. Conflicts are not a failed check:
 * the merge is left in progress and the integrator resolves it next. A story running in the project
 * itself has nothing to sync.
 */
import { workspace, root, reply, git, currentBranch, conflictedFiles, commitStoryReport } from "./lib.ts"

if (workspace === root) reply({ ok: true, note: "runs in the project itself" })
const base = currentBranch(root)
if (!base) reply({ ok: false, reason: "the project is not on a branch (detached HEAD); check out a branch, then retry" })

// An earlier round left a merge unresolved: the integrator has another go at it.
if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) reply({ ok: true, base, conflicts: conflictedFiles() })

// A report an earlier round wrote but did not commit would block every round from here on.
const story = process.env.SLATE_VAR_STORY
if (story) commitStoryReport(story)
const dirty = git(["status", "--porcelain"]).out
if (dirty) reply({ ok: false, reason: `the story's worktree has uncommitted changes, so ${base} cannot be merged in:\n${dirty.slice(0, 500)}` })

const merge = git(["merge", "--no-edit", base])
if (merge.ok) reply({ ok: true, base, conflicts: [] })
const conflicts = conflictedFiles()
if (conflicts.length) reply({ ok: true, base, conflicts })
reply({ ok: false, reason: `merging ${base} failed: ${merge.err || merge.out}`.slice(0, 800) })
