/**
 * Fails when a story's tasks are misnamed, have no scope, a scope reaches into the pack's own
 * folders or covers the whole project, or two tasks may modify the same files. A scope tells the
 * builder which files its task owns; the builder's `scope.protect` is what keeps it out of the
 * pack's documents. `scope.create` counts the same as `scope.modify`.
 *
 * The problems also go to stories/<story>/scope-check.md, which the next split reads: a script's
 * reason alone never reaches the agent. A passing check removes the file.
 */
import fs from "node:fs"
import path from "node:path"
import { checkYaml, reply, broken, workspace, taskScope, type TaskList } from "./lib.ts"

const story = process.argv[2] ?? process.env.SLATE_VAR_STORY ?? broken("usage: check-task-scopes <story>")
const record = path.join(workspace, "stories", story, "scope-check.md")
const fail = (problems: string[]): never => {
  fs.mkdirSync(path.dirname(record), { recursive: true })
  fs.writeFileSync(record, `# Scope check failed\n\nstories/${story}/tasks.yaml was rejected. Fix every problem, then write the file again.\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`)
  return reply({ ok: false, reason: problems.join("; ") })
}
const tasks = checkYaml<TaskList>(`stories/${story}/tasks.yaml`)?.tasks ?? []
if (!tasks.length) fail([`stories/${story}/tasks.yaml has no tasks`])

/** The fixed part of a glob, before its first wildcard: `src/a/**` -> `src/a/`. */
const fixedPrefix = (glob: string) => {
  const i = glob.search(/[*?[{]/)
  return i === -1 ? glob : glob.slice(0, i)
}
const scopeOf = (i: number) => (tasks[i] ? taskScope(tasks[i]) : [])
const problems: string[] = []
/** Folders the pack writes itself; a task's builder must not edit them. */
const RESERVED = ["specs/", "stories/", "tasks/", ".slate/", ".opencode/", ".git/", "node_modules/"]

for (const task of tasks) {
  if (!String(task.id).startsWith(`${story}-`)) problems.push(`task ${task.id} must start with ${story}-`)
  if (!taskScope(task).length) problems.push(`task ${task.id} has no scope: list the files or folders it creates or changes under scope.modify`)
  for (const glob of taskScope(task)) {
    const prefix = fixedPrefix(String(glob).replace(/^\.\//, ""))
    const reserved = RESERVED.find((r) => prefix.startsWith(r) || (prefix !== "" && r.startsWith(prefix)))
    if (reserved) problems.push(`task ${task.id} scope ${glob} reaches into ${reserved}, which the pack owns`)
    else if (prefix === "" && String(glob).includes("**")) problems.push(`task ${task.id} scope ${glob} covers the whole project; name the folders or files it changes`)
  }
}
for (let i = 0; i < tasks.length; i++) {
  for (let j = i + 1; j < tasks.length; j++) {
    for (const a of scopeOf(i)) {
      for (const b of scopeOf(j)) {
        const [pa, pb] = [fixedPrefix(a), fixedPrefix(b)]
        if (pa.startsWith(pb) || pb.startsWith(pa)) problems.push(`tasks ${tasks[i]!.id} and ${tasks[j]!.id} overlap: ${a} vs ${b}`)
      }
    }
  }
}

if (problems.length) fail(problems)
fs.rmSync(record, { force: true })
reply({ ok: true })
