/** The next story whose dependencies are all merged and that this loop has not handed out yet. */
import { readYaml, reply, broken, exists, claimedItems, type StoryGraph, type StoryIndex } from "./lib.ts"

const stories = readYaml<StoryIndex>("stories/index.yaml")?.stories ?? []
if (!stories.length) broken("stories/index.yaml has no stories")
const nodes = readYaml<StoryGraph>("stories/graph.yaml")?.nodes ?? {}
const claimed = claimedItems()
const merged = (id: string) => exists(`stories/${id}/merged.md`)
const open = stories.map((s) => ({ id: String(s.id), deps: [...(nodes[String(s.id)] ?? []), ...(s.depends_on ?? [])].map(String) })).filter((s) => !claimed.has(s.id) && !merged(s.id))

const ready = open.find((s) => s.deps.every(merged))
if (ready) reply({ next: ready.id })
// Nothing ready: done when nothing is left, otherwise wait for running stories to merge.
reply(open.length ? { next: null, waiting: open.map((s) => s.id) } : { done: true })
