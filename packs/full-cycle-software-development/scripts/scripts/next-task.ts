/**
 * The next task of a story that this loop has not handed out yet.
 * Each design round runs its own task loop, so after a redesign every task is built again.
 */
import { readYaml, reply, broken, claimedItems, type TaskList } from "./lib.ts"

const story = process.argv[2] ?? process.env.SLATE_VAR_STORY ?? broken("usage: next-task <story>")
const tasks = readYaml<TaskList>(`stories/${story}/tasks.yaml`)?.tasks ?? []
if (!tasks.length) broken(`stories/${story}/tasks.yaml has no tasks`)
const claimed = claimedItems()

const next = tasks.map((t) => String(t.id)).find((id) => !claimed.has(id))
reply(next ? { next } : { done: true })
