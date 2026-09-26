import { describe, expect, test } from "bun:test"
import path from "node:path"
import { existsSync } from "node:fs"
import { harness, referencePackDir, tmpProject } from "./helpers.ts"
import { ensureGitignore } from "../src/config/gitignore.ts"
import type { FakeBehavior } from "../src/opencode/fake.ts"

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
    // tasks ran in place, in the project itself (no worktrees)
    const build = h.runtime.calls.find((c) => c.step === "build")!
    expect(build.directory).toBe(h.root)
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
    const taskDir = (task: string) => path.join(h.root, "tasks", task)
    expect(existsSync(path.join(taskDir("s1-t1"), "design-1", "verdict-1.md"))).toBe(true)
    expect(existsSync(path.join(taskDir("s1-t1"), "design-2", "verdict-1.md"))).toBe(true)
    expect(existsSync(path.join(h.root, "stories/s1/merged.md"))).toBe(true)
    expect(existsSync(path.join(h.root, "stories/s2/merged.md"))).toBe(true)
  }, 120_000)
})

describe("parallel stories (git)", () => {
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const out = (cwd: string, ...args: string[]) => git(cwd, ...args).stdout.toString().trim()
  const write = (file: string, text: string) => Bun.write(file, text)

  /** s1 and s2 are independent; s3 needs both. */
  const plan: Record<string, FakeBehavior> = {
    stories: {
      run: async (req) => {
        await write(path.join(req.directory, "stories/index.yaml"), "stories:\n  - id: s1\n  - id: s2\n  - id: s3\n    depends_on: [s1, s2]\n")
        return { skipWrites: true }
      },
    },
    "story-graph": {
      run: async (req) => {
        await write(path.join(req.directory, "stories/graph.yaml"), "nodes:\n  s1: []\n  s2: []\n  s3: [s1, s2]\n")
        return { skipWrites: true }
      },
    },
  }
  /** The integrator: resolves a conflicted NOTES.md by keeping both sides, writes its report, commits. */
  const integrator: FakeBehavior = {
    run: async (req) => {
      const dir = req.directory
      if (out(dir, "diff", "--name-only", "--diff-filter=U").includes("NOTES.md")) {
        const sides = (await Bun.file(path.join(dir, "NOTES.md")).text()).split("\n").filter((l) => /^s\d/.test(l))
        await write(path.join(dir, "NOTES.md"), sides.sort().join("\n") + "\n")
        git(dir, "add", "NOTES.md")
        git(dir, "commit", "--no-edit")
      }
      await write(path.join(dir, `stories/${req.vars.story}/merged.md`), `# ${req.vars.story} merged\n`)
      git(dir, "add", "-A")
      git(dir, "commit", "-m", `${req.vars.story}: done`)
      return { skipWrites: true }
    },
  }

  async function gitHarness(behaviors: Record<string, FakeBehavior>) {
    const h = await harness({
      manifest: {},
      usePackDir: referencePackDir(),
      config: { config: { max_stories: 5 }, runtime: { worktrees: "git", step_timeout_minutes: 1, infra_retries: 1, contract_reprompts: 1 } },
      fake: { delayMs: 15, behaviors: { ...plan, merge: integrator, ...behaviors } },
    })
    await ensureGitignore(h.root)
    git(h.root, "init", "-q", "-b", "main")
    git(h.root, "config", "user.email", "t@t")
    git(h.root, "config", "user.name", "t")
    return h
  }

  test("independent stories build side by side in their own worktrees and land on the branch", async () => {
    const h = await gitHarness({
      build: {
        run: async (req) => {
          await write(path.join(req.directory, `src/${req.vars.story}.ts`), `export const story = "${req.vars.story}"\n`)
          return {}
        },
      },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    // s1 and s2 overlapped: s2 started building before s1 landed
    const at = (pred: (c: (typeof h.runtime.calls)[number]) => boolean) => h.runtime.calls.findIndex(pred)
    const s1 = "build/story-loop[0]/"
    const s2 = "build/story-loop[1]/"
    expect(at((c) => c.key.startsWith(s2))).toBeLessThan(at((c) => c.key.startsWith(s1) && c.step === "merge"))
    // each story worked in its own worktree, which is gone once it landed
    const dirs = new Set(h.runtime.calls.filter((c) => c.step === "build").map((c) => c.directory))
    expect([...dirs].sort()).toEqual(["s1", "s2", "s3"].map((s) => path.join(h.root, ".slate", "worktrees", s)))
    for (const d of dirs) expect(existsSync(d)).toBe(false)
    // everything landed on main, merges included; s3 was built on top of s1 and s2
    expect(out(h.root, "branch", "--show-current")).toBe("main")
    expect(out(h.root, "log", "--format=%s")).toContain("Merge story s3")
    for (const f of ["src/s1.ts", "src/s2.ts", "src/s3.ts", "stories/s1/merged.md", "stories/s3/merged.md", "tasks/s3-t2/design-1/tests-1.md"]) expect(existsSync(path.join(h.root, f))).toBe(true)
    expect(out(h.root, "log", "-1", "--format=%s", "--", "specs/tech-spec.md")).toBe("plan: specs and stories")
    expect(out(h.root, "branch", "--list", "slate/*")).toBe("")
    expect(out(h.root, "status", "--porcelain")).toBe("")
  }, 120_000)

  test("an integrator that writes its report but does not commit it does not wedge the story", async () => {
    // The fake's default for merge: write stories/<story>/merged.md, commit nothing (what `--dry-run` does).
    const h = await gitHarness({ merge: {} })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(out(h.root, "log", "--format=%s")).toContain("s1: done")
    expect(out(h.root, "log", "--format=%s")).toContain("Merge story s3")
    expect(out(h.root, "status", "--porcelain")).toBe("")
  }, 120_000)

  test("a story that conflicts with one that landed first is merged, resolved and landed", async () => {
    const h = await gitHarness({
      build: {
        run: async (req) => {
          if (req.vars.story !== "s3") await write(path.join(req.directory, "NOTES.md"), `${req.vars.story} was here\n`)
          return {}
        },
      },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(await Bun.file(path.join(h.root, "NOTES.md")).text()).toBe("s1 was here\ns2 was here\n")
    // the story that landed second merged main in and resolved the conflict on its own branch
    expect(out(h.root, "log", "--format=%s")).toMatch(/Merge branch 'main' into slate\/s[12]/)
    expect(out(h.root, "status", "--porcelain")).toBe("")
  }, 120_000)
})

describe("task split", () => {
  test("a split the scope check rejects is redone on its own, told why", async () => {
    const h = await harness({
      manifest: {},
      usePackDir: referencePackDir(),
      config: { config: { max_stories: 5 } },
      fake: {
        behaviors: {
          "split-tdd": {
            run: async (req, n) => {
              if (n > 1) return {}
              await Bun.write(path.join(req.directory, `stories/${req.vars.story}/tasks.yaml`), `tasks:\n  - id: ${req.vars.story}-t1\n    title: No scope\n`)
              return { skipWrites: true }
            },
          },
        },
      },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    const design = "build/story-loop[0]/design"
    expect(st.loops[design]).toMatchObject({ passed: true, round: 1 })
    expect(st.loops[`${design}{1}/split`]).toMatchObject({ passed: true, round: 2 })
    expect(h.runtime.calls.filter((c) => c.key.startsWith(`${design}{1}/tdd`) && c.step === "write-tdd")).toHaveLength(1)
    const second = h.runtime.calls.find((c) => c.key === `${design}{1}/split{2}/split-tdd`)!
    expect(second.prompt).toContain("The last round failed at check-scopes: task s1-t1 has no scope")
    // the check's record is gone once a split passes
    expect(existsSync(path.join(h.root, "stories/s1/scope-check.md"))).toBe(false)
  }, 120_000)
})

describe("check-task-scopes", () => {
  const script = path.join(referencePackDir(), "scripts/scripts/check-task-scopes.ts")
  const run = (root: string) => JSON.parse(Bun.spawnSync([process.execPath, script, "s1"], { env: { ...process.env, SLATE_WORKSPACE: root } }).stdout.toString() || "{}")
  const record = (root: string) => path.join(root, "stories/s1/scope-check.md")

  test("scope.create counts as the task's files", async () => {
    const root = await tmpProject()
    await Bun.write(path.join(root, "stories/s1/tasks.yaml"), "tasks:\n  - id: s1-t1\n    scope: { create: [public/manifest.json] }\n  - id: s1-t2\n    scope: { modify: [index.html] }\n")
    expect(run(root)).toEqual({ ok: true })
  })

  test("problems are written for the next split and cleared once it passes", async () => {
    const root = await tmpProject()
    await Bun.write(path.join(root, "stories/s1/tasks.yaml"), "tasks:\n  - id: s1-t1\n  - id: s1-t2\n    scope: { modify: ['src/**'] }\n  - id: s1-t3\n    scope: { create: [src/a.ts] }\n")
    expect(run(root)).toMatchObject({ ok: false })
    const text = await Bun.file(record(root)).text()
    expect(text).toContain("- task s1-t1 has no scope")
    expect(text).toContain("- tasks s1-t2 and s1-t3 overlap: src/** vs src/a.ts")
    await Bun.write(path.join(root, "stories/s1/tasks.yaml"), "tasks:\n  - id: s1-t1\n    scope: { modify: [src/a.ts] }\n")
    expect(run(root)).toEqual({ ok: true })
    expect(existsSync(record(root))).toBe(false)
  })
})

describe("tests step", () => {
  test("failing tests go back to the builder without a checker session", async () => {
    // The tech spec's test command fails the first time it runs, then passes.
    const h = await harness({
      manifest: {},
      usePackDir: referencePackDir(),
      config: { config: { max_stories: 5 } },
      fake: {
        behaviors: {
          "tech-spec": {
            run: async (req) => {
              await Bun.write(path.join(req.directory, "specs/tech-spec.md"), "test command: `test -f .tests-ok || { touch .tests-ok; echo boom; exit 1; }`\n")
              await Bun.write(path.join(req.directory, "specs/capabilities.yaml"), "needs: []\n")
              return { skipWrites: true }
            },
          },
        },
      },
    })
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    const bv = "build/story-loop[0]/design{1}/task-loop[0]/build-verify"
    expect(st.steps[`${bv}{1}/tests`]!.status).toBe("failed")
    expect(st.steps[`${bv}{1}/verify`]).toBeUndefined()
    expect(st.loops[bv]).toMatchObject({ passed: true, round: 2 })
    const first = await Bun.file(path.join(h.root, "tasks/s1-t1/design-1/tests-1.md")).text()
    expect(first).toStartWith("---\nverdict: \"fail\"")
    expect(first).toContain("boom")
    expect(await Bun.file(path.join(h.root, "tasks/s1-t1/design-1/tests-2.md")).text()).toStartWith("---\nverdict: \"pass\"")
    expect(h.runtime.calls.filter((c) => c.key.startsWith(bv)).map((c) => c.key.slice(bv.length))).toEqual(["{1}/build", "{2}/build", "{2}/verify"])
  }, 120_000)
})

describe("run-tests", () => {
  const script = path.join(referencePackDir(), "scripts/scripts/run-tests.ts")
  const run = (root: string) => {
    const r = Bun.spawnSync([process.execPath, script, "s1-t1", "1", "1"], { env: { ...process.env, SLATE_WORKSPACE: root } })
    return { code: r.exitCode, answer: JSON.parse(r.stdout.toString() || "{}") }
  }
  const record = (root: string) => Bun.file(path.join(root, "tasks/s1-t1/design-1/tests-1.md")).text()

  test("no test command yet passes with a note", async () => {
    const root = await tmpProject()
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts: {} }))
    expect(run(root)).toMatchObject({ code: 0, answer: { ok: true, note: "no test command" } })
    expect(await record(root)).toContain('command: "none"')
  })

  test("a failing command is a failed check with the output recorded", async () => {
    const root = await tmpProject()
    await Bun.write(path.join(root, "specs/tech-spec.md"), "Test command: `echo expected 2 got 3; exit 4`\n")
    expect(run(root)).toMatchObject({ code: 0, answer: { ok: false, reason: "tests failed (exit 4); output in tasks/s1-t1/design-1/tests-1.md" } })
    const text = await record(root)
    expect(text).toContain("exit: 4")
    expect(text).toContain("expected 2 got 3")
  })

  test("npm test is the fallback when package.json has a test script", async () => {
    const root = await tmpProject()
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts: { test: "echo all good" } }))
    expect(run(root)).toMatchObject({ code: 0, answer: { ok: true, pass: true } })
    expect(await record(root)).toContain("all good")
  })
})

describe("commit-task", () => {
  const script = path.join(referencePackDir(), "scripts/scripts/commit-task.ts")
  const run = (root: string) => {
    const r = Bun.spawnSync([process.execPath, script, "s1", "s1-t1"], { env: { ...process.env, SLATE_WORKSPACE: root } })
    return { code: r.exitCode, answer: JSON.parse(r.stdout.toString() || "{}") }
  }
  const git = (root: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe" }).stdout.toString().trim()

  test("commits a task's changes as '<task>: <title>', once", async () => {
    const root = await tmpProject()
    git(root, "init", "-q")
    git(root, "config", "user.email", "t@t")
    git(root, "config", "user.name", "t")
    await Bun.write(path.join(root, "stories/s1/tasks.yaml"), "tasks:\n  - id: s1-t1\n    title: Counter component\n")
    await Bun.write(path.join(root, "src/counter.ts"), "export const n = 1\n")
    expect(run(root)).toMatchObject({ code: 0, answer: { ok: true, committed: true } })
    expect(git(root, "log", "--format=%s")).toBe("s1-t1: Counter component")
    expect(run(root)).toMatchObject({ code: 0, answer: { ok: true, committed: false, note: "nothing changed" } })
  })

  test("outside git there is nothing to do", async () => {
    expect(run(await tmpProject())).toMatchObject({ code: 0, answer: { ok: true, committed: false, note: "not a git repository" } })
  })
})
