/**
 * Turns a UX review into work: the must-fix issues in stories/<story>/ux-review.yaml become one fix
 * story, appended to stories/index.yaml and graph.yaml (depending on the reviewed story), so the
 * story loop builds it next. The review and the plan change are committed on the project's branch
 * under the project lock, since stories land there meanwhile. A review with no must-fix issues files
 * nothing. A review file that does not parse, or that says fail with no issues, fails the check.
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, reply, broken, git, checkYaml, withProjectLock, type Story, type StoryIndex, type StoryGraph } from "./lib.ts"

const story = process.argv[2]
if (!story) broken("usage: file-ux-fixes <story>")

interface Issue {
  screen?: string
  viewport?: string
  problem?: string
  expected?: string
  severity?: string
}
const reviewRel = `stories/${story}/ux-review.yaml`
const review = checkYaml<{ verdict?: string; issues?: Issue[] }>(reviewRel)
if (!review) reply({ ok: false, reason: `${reviewRel} is missing` })
const issues = (review.issues ?? []).filter((i) => i && typeof i === "object")
const mustFix = issues.filter((i) => String(i.severity ?? "must-fix").toLowerCase() !== "nice-to-have")
if (review.verdict === "fail" && !mustFix.length) reply({ ok: false, reason: `${reviewRel} says fail but lists no must-fix issues` })

const answer = await withProjectLock(() => {
  const indexFile = path.join(workspace, "stories", "index.yaml")
  const graphFile = path.join(workspace, "stories", "graph.yaml")
  const index = (Bun.YAML.parse(fs.readFileSync(indexFile, "utf8")) ?? {}) as StoryIndex
  const stories = (index.stories ??= [])
  const reviewed = stories.find((s) => String(s.id) === story)
  if (!reviewed) broken(`story ${story} is not in stories/index.yaml`)
  const root = reviewed.ux_of ?? story
  const pass = (reviewed.ux_pass ?? 0) + 1
  const id = `${root}-ux${pass}`
  const paths = [reviewRel]
  let filed: string | undefined
  if (mustFix.length && !stories.some((s) => String(s.id) === id)) {
    const fix: Story = {
      id,
      title: `Fix the screen problems the UX review of ${story} found`,
      description: [
        `The UX designer looked at the screens of ${story} (${reviewRel}; screenshots and measurements in stories/${story}/ux/) and found:`,
        ...mustFix.map((i) => `- ${i.screen ?? "?"} at ${i.viewport ?? "every viewport"}: ${i.problem ?? "?"}`),
        "Change only what these problems need; keep everything else as it is.",
      ].join("\n"),
      acceptance: mustFix.map((i) => `${i.screen ?? "?"} at ${i.viewport ?? "every viewport"}: ${i.expected ?? `no longer ${i.problem ?? "broken"}`}`),
      depends_on: [story],
      screens: [...new Set(mustFix.map((i) => i.screen).filter((s): s is string => Boolean(s)))],
      ux_of: root,
      ux_pass: pass,
    }
    if (!fix.screens!.length) fix.screens = reviewed.screens
    stories.push(fix)
    fs.writeFileSync(indexFile, Bun.YAML.stringify(index, null, 2))
    const graph = (fs.existsSync(graphFile) ? Bun.YAML.parse(fs.readFileSync(graphFile, "utf8")) : {}) as StoryGraph
    graph.nodes = { ...(graph.nodes ?? {}), [id]: [story] }
    fs.writeFileSync(graphFile, Bun.YAML.stringify(graph, null, 2))
    paths.push("stories/index.yaml", "stories/graph.yaml")
    filed = id
  }
  if (git(["rev-parse", "--is-inside-work-tree"]).ok) {
    git(["add", "--", ...paths])
    if (!git(["diff", "--cached", "--quiet", "--", ...paths]).ok) {
      const commit = git(["commit", "-m", filed ? `UX review of ${story}: file ${filed}` : `UX review of ${story}: no fixes`, "--", ...paths])
      if (!commit.ok) broken(`git commit failed: ${commit.err.split("\n")[0]}`)
    }
  }
  return { ok: true, filed: filed ?? null, issues: mustFix.length, nice_to_have: issues.length - mustFix.length }
})
reply(answer)
