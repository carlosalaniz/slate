import { describe, expect, test } from "bun:test"
import path from "node:path"
import { writeFile, mkdir } from "node:fs/promises"
import { checkContracts, repromptText } from "../src/engine/contracts.ts"
import { loadCorePack, renderMessage, renderPrompt } from "../src/engine/core-pack.ts"
import { parseFrontmatter, readField } from "../src/util/frontmatter.ts"
import { resolveRuntime, resolveConfigValue } from "../src/engine/vars.ts"
import { tmpProject } from "./helpers.ts"

describe("contracts", () => {
  test("missing writes fail", async () => {
    const dir = await tmpProject()
    const r = await checkContracts({ directory: dir, writes: ["a/{story}.md"], vars: { story: "s1" } })
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(["a/s1.md"])
  })

  test("verdict must be exactly pass or fail", async () => {
    const dir = await tmpProject()
    await mkdir(path.join(dir, "t"), { recursive: true })
    const file = path.join(dir, "t", "v.md")
    await writeFile(file, "---\nverdict: mostly pass\n---\nbody")
    const bad = await checkContracts({ directory: dir, writes: ["t/v.md"], result: { file: "t/v.md", field: "verdict" }, vars: {} })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain("must be one of pass|fail")
    await writeFile(file, "---\nverdict: PASS\n---\nbody")
    const ok = await checkContracts({ directory: dir, writes: ["t/v.md"], result: { file: "t/v.md", field: "verdict" }, vars: {} })
    expect(ok.ok).toBe(true)
    expect(ok.verdict).toBe("pass")
    await writeFile(file, "no frontmatter\nverdict: fail\n")
    const body = await checkContracts({ directory: dir, writes: ["t/v.md"], result: { file: "t/v.md", field: "verdict" }, vars: {} })
    expect(body.ok).toBe(true)
    expect(body.verdict).toBe("fail")
  })

  test("reprompt text names the missing files and the schema", async () => {
    const core = await loadCorePack()
    const t = repromptText(core, { ok: false, missing: ["x.md"], reason: "missing" }, ["x.md", "v.md"], { file: "v.md", field: "verdict" })
    expect(t).toContain("x.md")
    expect(t).toContain("`verdict: pass` or `verdict: fail`")
    const noResult = repromptText(core, { ok: false, missing: ["x.md"], reason: "missing" }, ["x.md"])
    expect(noResult).not.toContain("frontmatter")
  })
})

describe("slate-core prompts", () => {
  test("every text Slate sends a model is a template in packs/slate-core/prompts", async () => {
    const core = await loadCorePack()
    expect(Object.keys(core.prompts).sort()).toEqual(["consult", "consult-tool", "consult-verdict", "decision", "discovery-agent", "discovery-handoff", "discovery-pack-lead", "discovery-start", "discovery-stub", "discovery-subagent", "gate-review", "pack-proposal", "plan-revision", "reprompt", "step"])
    expect(Object.keys(core.agents).sort()).toEqual(["slate-decision", "slate-intake", "slate-pack-proposer"])
    expect(Object.keys(core.skills)).toEqual(["slate-write-brief"])
    expect(Object.keys(core.messages).sort()).toEqual(["consult-from-consultant", "consult-limit", "consult-not-allowed", "consult-result", "consult-unavailable", "consult-unknown-agent", "consult-wrong-agent", "gate-ask", "gate-escalated", "gate-input-missing", "gate-rejected"])
    expect(renderMessage(core, "consult-limit", { max: 2 })).toBe("consult limit reached for this step (2)")
    expect(renderMessage(core, "consult-result", { answer: "Use a queue.", verdict: "approve", n: 1, max: 2 })).toBe("Use a queue.\n\n(verdict: approve; consult 1/2)")
  })

  test("a line whose placeholders are all empty is left out", () => {
    const core = { prompts: { t: "always\nstory: {story}\n{a} and {b}\nkept {unknown}" } } as never
    expect(renderPrompt(core, "t", { story: "", a: "x", b: undefined })).toBe("always\nx and \nkept {unknown}")
  })
})

describe("frontmatter and vars", () => {
  test("parses frontmatter and body", () => {
    const fm = parseFrontmatter("---\na: 1\nb: [x, y]\n---\nhello")
    expect(fm.present).toBe(true)
    expect(fm.data).toEqual({ a: 1, b: ["x", "y"] })
    expect(fm.body).toBe("hello")
    expect(readField("no fm\nverdict: pass", "verdict")).toBe("pass")
  })

  test("runtime and config vars", () => {
    expect(resolveRuntime("stories/{story}/review-{round}.md", { story: "s1", round: "2" })).toBe("stories/s1/review-2.md")
    expect(resolveRuntime("{round.tdd}", { "round.tdd": "3" })).toBe("3")
    expect(resolveRuntime("{missing}", {})).toBe("{missing}")
    expect(() => resolveRuntime("{missing}", {}, { strict: true })).toThrow()
    expect(resolveConfigValue<number>("${n}", { n: 4 }, "x")).toBe(4)
    expect(resolveConfigValue<string>("a-${n}", { n: 4 }, "x")).toBe("a-4")
  })
})
