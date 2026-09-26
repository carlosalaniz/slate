/**
 * Commits everything a verified task changed, as "<task>: <title>", on the current branch. Tasks
 * edit the project in place, so this is how each one ends up as its own commit. Not a git
 * repository, or nothing changed: nothing to do. A failing commit (for example no git identity)
 * stops the job, since every later task would hit it too.
 */
import { readYaml, reply, broken, workspace, type TaskList } from "./lib.ts"

const [story, task] = [process.argv[2] ?? process.env.SLATE_VAR_STORY, process.argv[3] ?? process.env.SLATE_VAR_TASK]
if (!story || !task) broken("usage: commit-task <story> <task>")

const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })

if (git("rev-parse", "--is-inside-work-tree").exitCode !== 0) reply({ ok: true, committed: false, note: "not a git repository" })
if (git("add", "-A").exitCode !== 0) broken("git add -A failed")
// Exit 0 means nothing is staged.
if (git("diff", "--cached", "--quiet").exitCode === 0) reply({ ok: true, committed: false, note: "nothing changed" })

const title = readYaml<TaskList>(`stories/${story}/tasks.yaml`)?.tasks?.find((t) => String(t.id) === task)?.title
const commit = git("commit", "-m", `${task}: ${title ?? "task"}`)
if (commit.exitCode !== 0) broken(`git commit failed: ${commit.stderr.toString().trim().split("\n")[0]}`)
reply({ ok: true, committed: true, commit: git("rev-parse", "--short", "HEAD").stdout.toString().trim() })
