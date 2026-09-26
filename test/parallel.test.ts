import { describe, expect, test } from "bun:test"
import path from "node:path"
import { writeFile, readFile } from "node:fs/promises"
import { harness, BASIC_AGENTS, BASIC_SKILLS } from "./helpers.ts"
import { LaneGroup } from "../src/engine/parallel.ts"

/** Stories come from queue.txt; a story is built once out/<story>.md exists. */
const scripts = {
  "next-story": {
    yml: { description: "next story", run: "bun $SLATE_PACK/scripts/scripts/next-story.ts" },
    code: `import fs from "node:fs"; const claimed = new Set(JSON.parse(process.env.SLATE_CLAIMED || "[]")); const q = fs.readFileSync("queue.txt", "utf8").split("\\n").filter(Boolean); const n = q.find((s) => !claimed.has(s)); console.log(JSON.stringify(n ? { next: n } : { done: true }))`,
  },
  "next-review": {
    yml: { description: "next review", run: "bun $SLATE_PACK/scripts/scripts/next-review.ts" },
    code: `import fs from "node:fs"; const claimed = new Set(JSON.parse(process.env.SLATE_CLAIMED || "[]")); const built = fs.existsSync("out") ? fs.readdirSync("out").filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : []; const n = built.sort().find((s) => !claimed.has(s)); console.log(JSON.stringify(n ? { next: n } : { done: true }))`,
  },
  reject: {
    yml: { description: "a failed check", run: "bun $SLATE_PACK/scripts/scripts/reject.ts" },
    code: `console.log(JSON.stringify({ ok: false, reason: "screens overlap" }))`,
  },
  "file-fix": {
    yml: { description: "files a fix story for s1's first review", run: "bun $SLATE_PACK/scripts/scripts/file-fix.ts" },
    code: `import fs from "node:fs"; const r = process.argv[2]; if (r === "s1") fs.appendFileSync("queue.txt", "s1-fix\\n"); console.log(JSON.stringify({ ok: true }))`,
  },
}

const build = (reviewFails = false) => [
  {
    id: "lanes",
    type: "parallel",
    steps: [
      { id: "stories", type: "loop", over: { script: "next-story" }, as: "story", max: 10, concurrency: 2, steps: [{ id: "make", type: "skill", skill: "make", by: "worker", writes: ["out/{story}.md"] }] },
      {
        id: "reviews",
        type: "loop",
        over: { script: "next-review" },
        as: "review",
        max: 10,
        steps: [
          { id: "look", type: "skill", skill: "check", by: "judge", writes: ["reviews/{review}.md"] },
          { id: "file", type: "script", script: reviewFails ? "reject" : "file-fix", args: ["{review}"] },
        ],
      },
    ],
  },
]

const manifest = (reviewFails = false) => ({ slate: 1, name: "p", version: "0.1.0", config: { on_exhausted: "fail" }, phases: { discovery: [], plan: [], build: build(reviewFails), close: [] } })

describe("parallel lanes", () => {
  test("a review lane feeds the story lane; both end only when neither has work left", async () => {
    const h = await harness({ manifest: manifest(), files: { agents: BASIC_AGENTS, skills: BASIC_SKILLS, scripts }, fake: { delayMs: 30 } })
    await writeFile(path.join(h.root, "queue.txt"), "s1\ns2\n")
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(st.loops["build/stories"]!.iterations!.map((i) => i.value).sort()).toEqual(["s1", "s1-fix", "s2"])
    expect(st.loops["build/reviews"]!.iterations!.map((i) => i.value).sort()).toEqual(["s1", "s1-fix", "s2"])
    expect(st.loops["build/stories"]!.overDone && st.loops["build/reviews"]!.overDone).toBe(true)
    // the fix story was built after the review that filed it
    expect((await readFile(path.join(h.root, "queue.txt"), "utf8")).trim().split("\n")).toEqual(["s1", "s2", "s1-fix"])
  }, 30_000)

  test("a failing lane fails the step; the other lane is left open for a resume", async () => {
    const h = await harness({ manifest: manifest(true), files: { agents: BASIC_AGENTS, skills: BASIC_SKILLS, scripts } })
    await writeFile(path.join(h.root, "queue.txt"), "s1\n")
    const st = await h.engine.run()
    expect(st.status).toBe("failed")
    expect(st.stopReason).toContain("review s1: file: screens overlap")
    expect(st.loops["build/stories"]!.overDone).toBeFalsy()
  }, 30_000)

  test("the group is quiet only when every lane looked since the last change", () => {
    const g = new LaneGroup(["a", "b"])
    const v = g.version
    g.settle("a", v)
    expect(g.quiet()).toBe(false)
    g.bump()
    g.settle("b", v) // b looked before the change: stale
    expect(g.quiet()).toBe(false)
    g.settle("a", g.version)
    g.settle("b", g.version)
    expect(g.quiet()).toBe(true)
  })
})
