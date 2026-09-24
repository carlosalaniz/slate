import { describe, expect, test } from "bun:test"
import path from "node:path"
import { existsSync } from "node:fs"
import { harness, referencePackDir } from "./helpers.ts"

describe("reference pack end to end (fake runtime)", () => {
  test("runs discovery, plan, build (2 stories x 2 tasks) and close", async () => {
    const h = await harness({ manifest: {}, usePackDir: referencePackDir(), config: { config: { max_stories: 5 }, runtime: { worktrees: "copy", step_timeout_minutes: 1, infra_retries: 1, contract_reprompts: 1 } } })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    for (const f of ["specs/product-scope.md", "specs/uiux-spec.md", "specs/tech-spec.md", "stories/index.yaml", "stories/graph.yaml", "stories/s1/TDD.md", "stories/s1/review-1.md", "stories/s1/tasks.yaml", "stories/s1/merged.md", "stories/s2/merged.md", "RUN-SUMMARY.md"]) {
      expect(existsSync(path.join(h.root, f))).toBe(true)
    }
    // every review step wrote a verdict: the fix for the 43%
    const reviews = Object.values(st.steps).filter((s) => s.step === "review-tdd" || s.step === "verify")
    expect(reviews.length).toBeGreaterThan(0)
    expect(reviews.every((r) => r.verdict === "pass" || r.verdict === "fail")).toBe(true)
    // stories ran in dependency order
    const stories = st.loops["build/story-loop"]!.iterations!.map((i) => i.value)
    expect(stories).toEqual(["s1", "s2"])
    // tasks ran in worktrees
    const build = h.runtime.calls.find((c) => c.step === "build")!
    expect(build.directory).toContain(".slate/worktrees/")
    expect(st.steps["plan/planning{1}/approve-plan"]!.status).toBe("passed")
    expect(st.spend.byStory["s1"]).toBeGreaterThan(0)
    // every story was designed once: nothing needed a redesign
    expect(st.loops["build/story-loop[0]/design"]).toMatchObject({ passed: true, round: 1 })
  }, 120_000)

  test("rejecting the plan with a note rewrites the stories, then asks again", async () => {
    const h = await harness({ manifest: {}, usePackDir: referencePackDir(), config: { config: { max_stories: 5 } }, engine: { autoApprove: false } })
    const run = h.engine.run()
    const approval = async (n: number) => {
      for (let i = 0; i < 400; i++) {
        const q = h.engine.state.questions.filter((x) => x.kind === "approval")[n]
        if (q) return q
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error(`approval #${n + 1} never asked`)
    }
    await h.engine.answer((await approval(0)).id, "reject", "split s1 into two stories")
    await h.engine.answer((await approval(1)).id, "approve")
    const st = await run
    expect(st.status).toBe("done")
    expect(h.runtime.calls.filter((c) => c.step === "stories").map((c) => c.key)).toEqual(["plan/planning{1}/stories", "plan/planning{2}/stories"])
    expect(st.loops["plan/planning"]).toMatchObject({ passed: true, round: 2 })
    expect(await Bun.file(path.join(h.root, ".slate", "plan-revisions.md")).text()).toContain("Rejected at approve-plan: split s1 into two stories")
    const second = h.runtime.calls.find((c) => c.key === "plan/planning{2}/stories")!.prompt
    expect(second).toContain("Earlier rounds of 'planning' did not pass")
    expect(second).toContain(".slate/plan-revisions.md")
  }, 120_000)

  test("a task that keeps failing verification sends its story back to design", async () => {
    // s1-t2 fails every verify in the first design; after the redesign it passes.
    const h = await harness({
      manifest: {},
      usePackDir: referencePackDir(),
      config: { config: { max_stories: 5 }, runtime: { worktrees: "copy", step_timeout_minutes: 1, infra_retries: 1, contract_reprompts: 1 } },
      fake: { behaviors: { verify: { run: (req) => ({ verdict: req.vars.task === "s1-t2" && req.vars["round.design"] === "1" ? "fail" : "pass" }) } } },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    const design = "build/story-loop[0]/design"
    expect(st.loops[design]).toMatchObject({ passed: true, round: 2 })
    expect(st.steps[`${design}{2}/tdd{1}/write-tdd`]!.status).toBe("passed")
    // three build rounds for s1-t2 under the first design, then the redesign
    expect(h.runtime.calls.filter((c) => c.step === "verify" && c.key.startsWith(`${design}{1}`) && c.key.includes("[1]"))).toHaveLength(3)
    const redesign = h.runtime.calls.find((c) => c.key === `${design}{2}/tdd{1}/write-tdd`)!
    expect(redesign.prompt).toContain("This is design round 2")
    // the new design rebuilds every task, including s1-t1 which passed under the first design
    expect(st.loops[`${design}{2}/task-loop`]!.iterations!.map((i) => `${i.value}:${i.status}`)).toEqual(["s1-t1:done", "s1-t2:done"])
    const worktree = (task: string) => path.join(h.root, ".slate", "worktrees", task, "tasks", task)
    expect(existsSync(path.join(worktree("s1-t1"), "design-1", "verdict-1.md"))).toBe(true)
    expect(existsSync(path.join(worktree("s1-t1"), "design-2", "verdict-1.md"))).toBe(true)
    expect(existsSync(path.join(h.root, "stories/s1/merged.md"))).toBe(true)
    expect(existsSync(path.join(h.root, "stories/s2/merged.md"))).toBe(true)
  }, 120_000)
})
