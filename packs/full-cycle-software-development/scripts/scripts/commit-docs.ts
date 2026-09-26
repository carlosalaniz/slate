/**
 * Commits everything changed in the project with the given message: the specs and the plan before
 * the build (story worktrees only see committed files), the run summary and changelog at the end.
 * Not a git repository, or nothing changed: nothing to do.
 */
import { reply, broken, git } from "./lib.ts"

const message = process.argv[2]
if (!message) broken("usage: commit-docs <message>")
if (!git(["rev-parse", "--is-inside-work-tree"]).ok) reply({ ok: true, committed: false, note: "not a git repository" })
if (!git(["add", "-A"]).ok) broken("git add -A failed")
if (git(["diff", "--cached", "--quiet"]).ok) reply({ ok: true, committed: false, note: "nothing changed" })
const commit = git(["commit", "-m", message])
if (!commit.ok) broken(`git commit failed: ${commit.err.split("\n")[0]}`)
reply({ ok: true, committed: true, commit: git(["rev-parse", "--short", "HEAD"]).out })
