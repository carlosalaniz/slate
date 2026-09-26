/**
 * The next landed story whose screens a UX review should look at. A story is reviewed once, after it
 * lands (stories/<id>/merged.md is on the project's branch), when it lists `screens:`. A fix story a
 * review filed is reviewed again while its pass is within the limit: story s4 is pass 1, its fix
 * s4-ux1 pass 2, and so on up to `ux_passes`. Nothing to review: the pack runs no reviews at all
 * (ux_passes 0, playwright or image input waived, or the tech spec says the app has no serve command).
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, readYaml, reply, exists, claimedItems, waived, type StoryIndex } from "./lib.ts"

const passes = Number(process.argv[2] ?? 0)
if (!passes) reply({ done: true, note: "UX review is off (ux_passes: 0)" })
const skip = waived()
for (const id of ["playwright", "image-input"]) if (skip.has(id)) reply({ done: true, note: `UX review is off: ${id} is waived` })
const spec = path.join(workspace, "specs", "tech-spec.md")
if (fs.existsSync(spec) && /serve command[^`\n]*`\s*none\s*`/i.test(fs.readFileSync(spec, "utf8"))) reply({ done: true, note: "the app has no screens to serve" })

const claimed = claimedItems()
const stories = readYaml<StoryIndex>("stories/index.yaml")?.stories ?? []
const next = stories.find((s) => {
  const id = String(s.id)
  const pass = (s.ux_pass ?? 0) + 1
  return (s.screens ?? []).length > 0 && pass <= passes && !claimed.has(id) && exists(`stories/${id}/merged.md`) && !exists(`stories/${id}/ux-review.yaml`)
})
// In the build's parallel step, "done" means "nothing now": stories still landing come back here.
reply(next ? { next: String(next.id) } : { done: true })
