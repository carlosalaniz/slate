import { describe, expect, test } from "bun:test"
import path from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { harness, testConfig, BASIC_AGENTS, BASIC_SKILLS, type Harness } from "./helpers.ts"
import { AuditLog } from "../src/engine/audit.ts"
import { StateStore } from "../src/engine/state.ts"
import { Engine } from "../src/engine/engine.ts"
import { FakeRuntime, type FakeOptions } from "../src/opencode/fake.ts"
import { projectPaths } from "../src/config/paths.ts"
import { loadPack } from "../src/pack/loader.ts"
import type { ProjectConfig } from "../src/config/project.ts"
import { relayRuntimeQuestion } from "../src/engine/inbox.ts"

const nextScript = (values: string[]) => ({
  yml: { description: "next", run: "bun $SLATE_PACK/scripts/scripts/next.ts", timeout: "10s" },
  code: `const claimed = new Set<string>(JSON.parse(process.env.SLATE_CLAIMED || "[]")); const vals = ${JSON.stringify(values)}; const n = vals.find(v => !claimed.has(v)); console.log(JSON.stringify(n ? { next: n } : { done: true }))`,
})

const untilLoop = (max: number, on_exhausted: unknown = "fail") => ({
  id: "bv",
  type: "loop",
  until: { result: "verify" },
  max,
  on_exhausted,
  steps: [
    { id: "build", type: "skill", skill: "make", by: "worker", writes: ["out/{task}-build-{round}.md"] },
    { id: "verify", type: "skill", skill: "check", by: "judge", writes: ["out/{task}-verdict-{round}.md"], result: { file: "out/{task}-verdict-{round}.md", field: "verdict" } },
  ],
})

/** A second engine over the same project, as `slate continue` would build it. */
async function resume(h: Harness, fake: FakeOptions = {}, config: Partial<ProjectConfig> = {}) {
  const paths = projectPaths(h.root)
  const runtime = new FakeRuntime(fake)
  const engine = new Engine({ root: h.root, paths, runtime, project: testConfig(config), state: (await StateStore.open(paths.state))!, audit: await AuditLog.open(paths.log, "job1"), installedPacks: [], pack: await loadPack(h.pack), autoApprove: true, pollMs: 10, log: () => undefined })
  return { engine, runtime, state: await engine.run() }
}

function manifest(build: unknown[], extra: Record<string, unknown> = {}) {
  return { slate: 1, name: "p", version: "0.1.0", config: { on_exhausted: "fail" }, phases: { discovery: [], plan: [], build, close: [] }, ...extra }
}

const files = { agents: BASIC_AGENTS, skills: BASIC_SKILLS, scripts: { next: nextScript(["t1", "t2"]) } }

describe("engine", () => {
  test("runs an over loop with a nested until loop and records verdicts", async () => {
    const h = await harness({ manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(3)] }]), files })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(st.phase).toBe("done")
    expect(existsSync(path.join(h.root, "out", "t1-verdict-1.md"))).toBe(true)
    expect(existsSync(path.join(h.root, "out", "t2-verdict-1.md"))).toBe(true)
    const it = st.loops["build/tasks"]!.iterations!
    expect(it.map((i) => i.value)).toEqual(["t1", "t2"])
    expect(it.every((i) => i.status === "done")).toBe(true)
    expect(st.steps["build/tasks[0]/bv{1}/verify"]!.verdict).toBe("pass")
    expect(h.runtime.calls.filter((c) => c.step === "build")).toHaveLength(2)
    // vars flow into prompts
    expect(h.runtime.calls[0]!.prompt).toContain("make {story} t1 round 1")
    expect(st.spend.total).toBeCloseTo(0.04, 5)
    expect(st.spend.byTask["t1"]).toBeCloseTo(0.02, 5)
  })

  test("a missing verdict file fails the step, gets one re-prompt, then counts as a failed round", async () => {
    let verifyCalls = 0
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(3)] }]),
      files: { ...files, scripts: { next: nextScript(["t1"]) } },
      fake: { behaviors: { verify: { run: () => ({ skipWrites: ++verifyCalls === 1 }) } } },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(h.runtime.reprompts).toHaveLength(1)
    expect(h.runtime.reprompts[0]).toContain("t1-verdict-1.md")
    expect(st.contractFailures).toHaveLength(2)
    expect(st.steps["build/tasks[0]/bv{1}/verify"]!.status).toBe("failed")
    expect(st.steps["build/tasks[0]/bv{2}/verify"]!.verdict).toBe("pass")
    const log = await AuditLog.read(projectPaths(h.root).log)
    expect(log.some((r) => r.event.type === "contract.failed")).toBe(true)
  })

  test("a fail verdict retries until max; on_exhausted: fail with no outer loop fails the job; continue grants max more rounds", async () => {
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(2, "fail")] }]),
      files: { ...files, scripts: { next: nextScript(["t1"]) } },
      fake: { behaviors: { verify: { run: () => ({ verdict: "fail" }) } } },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("failed")
    expect(st.stopReason).toContain("out of rounds after 2")
    expect(st.stopReason).toContain("task t1")
    expect(h.runtime.calls.filter((c) => c.step === "build")).toHaveLength(2)
    // slate continue is the retry: the loop gets 2 more rounds and picks up at round 3
    const r = await resume(h)
    expect(r.state.status).toBe("done")
    expect(r.runtime.calls.map((c) => c.key)).toEqual(["build/tasks[0]/bv{3}/build", "build/tasks[0]/bv{3}/verify"])
  })

  test("a failed step outside any loop fails the job; continue re-runs only that step", async () => {
    const h = await harness({
      manifest: manifest([
        { id: "one", type: "skill", skill: "make", by: "worker", writes: ["one.md"] },
        { id: "two", type: "skill", skill: "make", by: "worker", writes: ["two.md"] },
      ]),
      files,
      fake: { behaviors: { two: { run: () => ({ skipWrites: true }) } } },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("failed")
    expect(st.stopReason).toContain("build failed at two")
    expect(st.questions).toHaveLength(0)
    const r = await resume(h)
    expect(r.state.status).toBe("done")
    expect(r.runtime.calls.map((c) => c.step)).toEqual(["two"])
  })

  const redesign = (buildMax: number, designMax: number) =>
    manifest([
      {
        id: "stories",
        type: "loop",
        over: { script: "next" },
        as: "story",
        max: 10,
        steps: [
          {
            id: "design",
            type: "loop",
            until: { result: "signoff" },
            max: designMax,
            on_exhausted: "fail",
            steps: [
              { id: "plan-it", type: "skill", skill: "make", by: "worker", writes: ["d/{story}-{round}.md"] },
              { id: "tasks", type: "loop", over: { script: "next-task" }, as: "task", max: 10, steps: [untilLoop(buildMax, "fail")] },
              { id: "signoff", type: "skill", skill: "check", by: "judge", writes: ["d/{story}-ok-{round}.md"], result: { file: "d/{story}-ok-{round}.md", field: "verdict" } },
            ],
          },
        ],
      },
    ])
  const redesignFiles = { ...files, scripts: { next: nextScript(["s1"]), "next-task": nextScript(["s1-t1"]) } }

  test("a task that runs out of build rounds fails the design round, and the outer loop redesigns", async () => {
    let verifyCalls = 0
    const h = await harness({ manifest: redesign(1, 2), files: redesignFiles, fake: { behaviors: { verify: { run: () => ({ verdict: ++verifyCalls === 1 ? "fail" : "pass" }) } } } })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(h.runtime.calls.filter((c) => c.step === "plan-it").map((c) => c.key)).toEqual(["build/stories[0]/design{1}/plan-it", "build/stories[0]/design{2}/plan-it"])
    expect(h.runtime.calls.filter((c) => c.step === "signoff")).toHaveLength(1)
    expect(st.loops["build/stories[0]/design"]!.round).toBe(2)
    expect(st.loops["build/stories[0]/design{1}/tasks"]!.iterations![0]!.status).toBe("failed")
    // the step prompt says which loops the agent is in and that an earlier design round failed
    const second = h.runtime.calls.find((c) => c.key === "build/stories[0]/design{2}/plan-it")!.prompt
    expect(second).toContain("'design' round 2 of 2")
    expect(second).toContain("Earlier rounds of 'design' did not pass")
    expect(existsSync(path.join(h.root, "d", "s1-2.md"))).toBe(true)
  })

  test("when the outer loop also runs out, its own policy applies", async () => {
    const h = await harness({ manifest: redesign(1, 2), files: redesignFiles, fake: { behaviors: { verify: { run: () => ({ verdict: "fail" }) } } } })
    const st = await h.engine.run()
    expect(st.status).toBe("failed")
    expect(st.stopReason).toContain("design: out of rounds after 2")
    expect(h.runtime.calls.filter((c) => c.step === "plan-it")).toHaveLength(2)
  })

  test("ask-decision-agent uses slate-core's decision agent and records its answer", async () => {
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(1, "ask-decision-agent")] }, { id: "after", type: "skill", skill: "make", by: "worker", writes: ["after.md"] }]),
      files: { ...files, scripts: { next: nextScript(["t1"]) } },
      fake: { behaviors: { verify: { run: () => ({ verdict: "fail" }) } }, reviews: { "slate-decision": "skip\nthe task is optional" } },
      engine: { autoApprove: false },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    const q = st.questions.find((x) => x.kind === "exhausted")!
    expect(q.answered).toMatchObject({ answer: "skip", by: "decision-agent" })
    expect(st.loops["build/tasks[0]/bv"]!.skipped).toBe(true)
    expect(h.runtime.reviewsMade[0]!.prompt).toContain("Loop 'bv' has used all 1 rounds")
    expect(existsSync(path.join(h.root, "after.md"))).toBe(true)
  })

  test("approval blocks until answered through the answers directory; other work continues in build", async () => {
    const h = await harness({
      manifest: manifest([
        { id: "stories", type: "loop", over: { script: "next" }, as: "story", max: 10, concurrency: 2, steps: [{ id: "ok", type: "approval", prompt: "go {story}?" }, { id: "w", type: "skill", skill: "make", by: "worker", writes: ["w/{story}.md"] }] },
      ]),
      files: { ...files, scripts: { next: nextScript(["s1", "s2"]) } },
      engine: { autoApprove: false },
    })
    const paths = projectPaths(h.root)
    const run = h.engine.run()
    // wait until both questions exist
    for (let i = 0; i < 200 && h.engine.state.questions.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(h.engine.state.questions).toHaveLength(2)
    expect(h.engine.state.branches["story:s1"]!.status).toBe("blocked")
    // every branch waits on a question and nothing runs: the job as a whole is blocked
    expect(h.engine.state.status).toBe("blocked")
    // answer only s2 first: s2 proceeds while s1 stays blocked
    const q2 = h.engine.state.questions.find((q) => q.prompt.includes("s2"))!
    await mkdir(paths.answers, { recursive: true })
    await writeFile(path.join(paths.answers, `${q2.id}.json`), JSON.stringify({ answer: "approve" }))
    for (let i = 0; i < 200 && !existsSync(path.join(h.root, "w", "s2.md")); i++) await new Promise((r) => setTimeout(r, 10))
    expect(existsSync(path.join(h.root, "w", "s2.md"))).toBe(true)
    expect(existsSync(path.join(h.root, "w", "s1.md"))).toBe(false)
    const q1 = h.engine.state.questions.find((q) => q.prompt.includes("s1"))!
    await writeFile(path.join(paths.answers, `${q1.id}.json`), JSON.stringify({ answer: "approve" }))
    const st = await run
    expect(st.status).toBe("done")
    expect(st.questions.every((q) => q.answered)).toBe(true)
  })

  test("stop checkpoints after the current step and continue resumes without replaying", async () => {
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(3)] }]),
      files: { ...files, scripts: { next: nextScript(["t1", "t2", "t3"]) } },
      fake: { delayMs: 30 },
    })
    const run = h.engine.run()
    for (let i = 0; i < 100 && h.runtime.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    h.engine.requestStop(false)
    const st = await run
    expect(st.status).toBe("stopped")
    const doneBefore = Object.values(st.steps).filter((s) => s.status === "passed").length
    expect(doneBefore).toBeGreaterThan(0)
    expect(Object.values(st.steps).some((s) => s.status === "running")).toBe(false)
    // resume with a fresh engine and runtime
    const paths = projectPaths(h.root)
    const store = (await StateStore.open(paths.state))!
    const runtime2 = new FakeRuntime()
    const audit = await AuditLog.open(paths.log, "job1")
    const pack = (await import("../src/pack/loader.ts")).loadPack
    const engine2 = new Engine({ root: h.root, paths, runtime: runtime2, project: (await import("./helpers.ts")).testConfig(), state: store, audit, installedPacks: [], pack: await pack(h.pack), autoApprove: true, pollMs: 10, log: () => undefined })
    const st2 = await engine2.run()
    expect(st2.status).toBe("done")
    const passedAfter = Object.values(st2.steps).filter((s) => s.status === "passed").length
    expect(passedAfter).toBeGreaterThan(doneBefore)
    // nothing that passed before was run again
    for (const c of runtime2.calls) expect(st.steps[c.key]?.status ?? "none").not.toBe("passed")
    expect(st2.loops["build/tasks"]!.iterations!.map((i) => i.value)).toEqual(["t1", "t2", "t3"])
  })

  test("a hard stop mid-iteration resumes that iteration at the next step", async () => {
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(3)] }]),
      files: { ...files, scripts: { next: nextScript(["t1", "t2"]) } },
      fake: { delayMs: 20 },
    })
    const run = h.engine.run()
    for (let i = 0; i < 100 && h.runtime.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 5))
    h.engine.requestStop(true)
    const st = await run
    expect(st.status).toBe("stopped")
    expect(st.loops["build/tasks"]!.iterations![0]!.status).toBe("interrupted")
    const paths = projectPaths(h.root)
    const store = (await StateStore.open(paths.state))!
    const runtime2 = new FakeRuntime()
    const engine2 = new Engine({ root: h.root, paths, runtime: runtime2, project: (await import("./helpers.ts")).testConfig(), state: store, audit: await AuditLog.open(paths.log, "job1"), installedPacks: [], pack: await (await import("../src/pack/loader.ts")).loadPack(h.pack), autoApprove: true, pollMs: 10, log: () => undefined })
    const st2 = await engine2.run()
    expect(st2.status).toBe("done")
    expect(st2.loops["build/tasks"]!.iterations!.map((i) => `${i.value}:${i.status}`)).toEqual(["t1:done", "t2:done"])
    // the passed build of t1 was not re-run; verify of t1 and all of t2 were
    expect(runtime2.calls.map((c) => c.step)).toEqual(["verify", "build", "verify"])
    expect(runtime2.calls[0]!.key).toBe("build/tasks[0]/bv{1}/verify")
  })

  test("infrastructure failures retry and never count as rounds", async () => {
    let n = 0
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(1, "fail")] }]),
      files: { ...files, scripts: { next: nextScript(["t1"]) } },
      fake: { behaviors: { build: { run: () => (++n === 1 ? { outcome: "failed", skipWrites: true, error: { type: "rate_limit", message: "429", status: 429 } } : {}) } } },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(h.runtime.calls.filter((c) => c.step === "build")).toHaveLength(2)
    expect(st.loops["build/tasks[0]/bv"]!.round).toBe(1)
    const rec = st.steps["build/tasks[0]/bv{1}/build"]!
    expect(rec.attempts.some((a) => a.failureClass === "infra")).toBe(true)
    expect(rec.status).toBe("passed")
  })

  test("a broken script stops the job instead of failing the check; continue re-runs it once fixed", async () => {
    const h = await harness({
      manifest: manifest([{ id: "chk", type: "script", script: "broken" }, { id: "w", type: "skill", skill: "make", by: "worker", writes: ["w.md"] }]),
      files: { ...files, scripts: { broken: { yml: { description: "b", run: "bun $SLATE_PACK/scripts/scripts/broken.ts", timeout: "5s" }, code: "process.exit(3)" } } },
      engine: { autoApprove: false },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("stopped")
    expect(st.stopReason).toContain("script 'broken' is broken")
    expect(st.questions).toHaveLength(0)
    expect(st.steps["build/chk"]!.status).toBe("failed")
    await writeFile(path.join(h.pack, "scripts", "scripts", "broken.ts"), "console.log(JSON.stringify({ ok: true }))")
    const r = await resume(h)
    expect(r.state.status).toBe("done")
    expect(r.state.steps["build/chk"]!.status).toBe("passed")
  })

  test("a budget cap stops the job at the next step; raising it and continuing finishes", async () => {
    const budget = (job: number) => ({ budget: { job, per_task: 100, per_model: {} } })
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(1)] }]),
      files: { ...files, scripts: { next: nextScript(["t1", "t2"]) } },
      fake: { costPerStep: 1 },
      config: budget(1.5),
      engine: { autoApprove: false },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("stopped")
    expect(st.stopReason).toContain("budget.job")
    expect(st.questions).toHaveLength(0)
    // the step that crossed the cap finished and was kept
    expect(st.steps["build/tasks[0]/bv{1}/verify"]!.status).toBe("passed")
    const log = await AuditLog.read(projectPaths(h.root).log)
    expect(log.some((r) => r.event.type === "budget")).toBe(true)
    const r = await resume(h, { costPerStep: 1 }, budget(100))
    expect(r.state.status).toBe("done")
    expect(r.runtime.calls.every((c) => c.key.startsWith("build/tasks[1]"))).toBe(true)
  })

  test("worktree per task: build runs in an isolated directory", async () => {
    const h = await harness({
      manifest: manifest([{ id: "tasks", type: "loop", over: { script: "next" }, as: "task", max: 10, steps: [untilLoop(1)] }]),
      files: { ...files, scripts: { next: nextScript(["t1"]) } },
      config: { runtime: { worktrees: "copy", step_timeout_minutes: 1, infra_retries: 1, contract_reprompts: 1 } },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    const call = h.runtime.calls.find((c) => c.step === "build")!
    expect(call.directory).toContain(path.join(".slate", "worktrees", "t1"))
    expect(existsSync(path.join(call.directory, "out", "t1-verdict-1.md"))).toBe(true)
  })

  test("scope narrows from tasks.yaml and permission rules deny outside it", async () => {
    const h = await harness({
      manifest: manifest([
        {
          id: "b",
          type: "skill",
          skill: "make",
          by: "worker",
          scope: { from: "stories/s1/tasks.yaml#s1-t1.scope", within: { modify: ["src/**", "tests/**"] } },
          writes: ["out/b-report.md"],
        },
      ]),
      files,
    })
    await mkdir(path.join(h.root, "stories", "s1"), { recursive: true })
    await writeFile(path.join(h.root, "stories", "s1", "tasks.yaml"), "tasks:\n  - id: s1-t1\n    scope: { modify: ['src/a/**', 'docs/**'] }\n")
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    const call = h.runtime.calls[0]!
    expect(call.prompt).toContain("src/a/**")
    expect(call.prompt).not.toContain("docs/**")
    // The step's own report is editable even though the task scope does not list it.
    expect(call.permissions).toContainEqual({ action: "edit", resource: "out/b-report.md", effect: "allow" })
    expect(call.permissions).toContainEqual({ action: "edit", resource: "src/a/**", effect: "allow" })
  })
})

describe("engine intake", () => {
  test("intake writes brief.md, proposes a pack and pins it", async () => {
    const h = await harness({ manifest: manifest([{ id: "w", type: "skill", skill: "make", by: "worker", writes: ["w.md"] }]), files, idea: "a tiny web app" })
    const paths = projectPaths(h.root)
    await Bun.write(paths.brief, "") // simulate no brief yet
    const { removePath } = await import("../src/util/fs.ts")
    await removePath(paths.brief)
    await h.store.update((s) => {
      s.phase = "intake"
      s.job.pack = undefined
    })
    const installed = [{ name: "p", version: "0.1.0", dir: h.pack, source: "project" as const, description: "test pack", fits: "tiny web app things" }]
    const engine = new Engine({ root: h.root, paths, runtime: new FakeRuntime(), project: (await import("./helpers.ts")).testConfig(), state: h.store, audit: await AuditLog.open(paths.log, "job1"), installedPacks: installed, autoApprove: true, pollMs: 10, log: () => undefined })
    const st = await engine.run()
    expect(st.status).toBe("done")
    expect(existsSync(paths.brief)).toBe(true)
    expect(st.job.pack?.name).toBe("p")
    expect((await readFile(paths.brief, "utf8")).length).toBeGreaterThan(0)
  })
})

describe("autonomy levels", () => {
  const step = { id: "build", type: "skill", skill: "make", by: "worker", writes: [] } as never
  const ctx = { prefix: "build", branch: "main", vars: {}, directory: "/", phase: "build", untilStack: [] } as never
  const ask = (command: string) => ({ kind: "permission" as const, sessionID: "s", requestID: command, action: "shell", resources: [command] })

  for (const [autonomy, routine, risky] of [
    ["supervised", "policy", undefined],
    ["strict", undefined, undefined],
    ["unattended", "policy", "policy"],
  ] as const) {
    test(`${autonomy}: routine permission ${routine ? "goes through" : "asks"}, risky ${risky ? "goes through" : "asks"}`, async () => {
      const h = await harness({ manifest: manifest([{ id: "w", type: "skill", skill: "make", by: "worker", writes: ["w.md"] }]), files, engine: { autonomy, autoApprove: autonomy === "unattended" } })
      await relayRuntimeQuestion(h.engine, ask('python3 -c "import yaml"'), ctx, step, "build/w")
      await relayRuntimeQuestion(h.engine, ask("git push origin main"), ctx, step, "build/w")
      const [a, b] = h.engine.state.questions
      expect(a!.answered?.by).toBe(routine)
      expect(b!.answered?.by).toBe(risky)
    })
  }
})
