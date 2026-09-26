/** Fails when stories/graph.yaml is missing a story, names an unknown one, or has a cycle. */
import { checkYaml, reply, type StoryGraph, type StoryIndex } from "./lib.ts"

const stories = (checkYaml<StoryIndex>("stories/index.yaml")?.stories ?? []).map((s) => String(s.id))
const nodes = checkYaml<StoryGraph>("stories/graph.yaml")?.nodes ?? {}
const dependenciesOf = (id: string) => (nodes[id] ?? []).map(String)
const problems: string[] = []

for (const story of stories) if (!(story in nodes)) problems.push(`graph.yaml is missing story ${story}`)
for (const id of Object.keys(nodes)) {
  for (const dep of dependenciesOf(id)) if (!stories.includes(dep)) problems.push(`${id} depends on unknown story ${dep}`)
}

// Depth-first search; meeting a story that is still on the stack means a cycle.
const visiting = new Set<string>()
const finished = new Set<string>()
function visit(id: string, path: string[]): void {
  if (finished.has(id)) return
  if (visiting.has(id)) {
    problems.push(`cycle: ${[...path, id].join(" -> ")}`)
    return
  }
  visiting.add(id)
  for (const dep of dependenciesOf(id)) visit(dep, [...path, id])
  visiting.delete(id)
  finished.add(id)
}
for (const id of Object.keys(nodes)) visit(id, [])

reply(problems.length ? { ok: false, reason: problems.join("; ") } : { ok: true })
