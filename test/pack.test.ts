import { describe, expect, test } from "bun:test"
import { loadPack, PackError } from "../src/pack/loader.ts"
import { validatePackDir, listInstalledPacks } from "../src/pack/registry.ts"
import { tmpProject, writePack, BASIC_AGENTS, BASIC_SKILLS, referencePackDir } from "./helpers.ts"

const manifest = (build: unknown[]) => ({ slate: 1, name: "p", version: "0.1.0", config: { max_rounds: 2, policy: "ask-human" }, phases: { discovery: [], plan: [], build, close: [] } })

describe("pack loader", () => {
  test("loads the reference pack", async () => {
    const r = await validatePackDir(referencePackDir())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Object.keys(r.pack.agents).sort()).toEqual(["analyst", "architect", "builder", "checker", "integrator", "product-owner", "product-owner-consultant", "reviewer", "staff-engineer", "uiux-designer"])
      expect(Object.keys(r.pack.skills)).toHaveLength(12)
      const loop = r.pack.manifest.phases.build[0]!
      expect(loop.type).toBe("loop")
      if (loop.type === "loop") expect(loop.max).toBe(50)
    }
  })

  test("resolves ${config} placeholders including overrides", async () => {
    const dir = await tmpProject()
    const p = await writePack(dir, manifest([{ id: "l", type: "loop", until: { result: "c" }, max: "${max_rounds}", on_exhausted: "${policy}", steps: [{ id: "m", type: "skill", skill: "make", by: "worker", writes: ["a.md"] }, { id: "c", type: "skill", skill: "check", by: "judge", writes: ["v.md"], result: { file: "v.md", field: "verdict" } }] }]), { agents: BASIC_AGENTS, skills: BASIC_SKILLS })
    const pack = await loadPack(p, { max_rounds: 5 })
    const loop = pack.manifest.phases.build[0]!
    if (loop.type !== "loop") throw new Error("expected loop")
    expect(loop.max).toBe(5)
    expect(loop.on_exhausted).toBe("ask-human")
  })

  test("rejects unknown references, duplicate ids, id keys and wrong roles", async () => {
    const dir = await tmpProject()
    const p = await writePack(
      dir,
      manifest([
        { id: "a", type: "skill", skill: "nope", by: "worker", writes: [] },
        { id: "a", type: "script", script: "missing" },
        { id: "l", type: "loop", until: { result: "x" }, max: 1, steps: [{ id: "x", type: "skill", skill: "make", by: "advisor", writes: [] }] },
      ]),
      { agents: { ...BASIC_AGENTS, bad: { id: "bad", role: "worker", prompt: "x" } }, skills: BASIC_SKILLS },
    )
    let err: PackError | undefined
    try {
      await loadPack(p)
    } catch (e) {
      err = e as PackError
    }
    expect(err).toBeInstanceOf(PackError)
    const text = err!.problems.join("\n")
    expect(text).toContain("unknown skill 'nope'")
    expect(text).toContain("used twice")
    expect(text).toContain("unknown script 'missing'")
    expect(text).toContain("do not set 'id'")
    expect(text).toContain("role consultant; only workers run skill steps")
    expect(text).toContain("must be a skill step that declares result")
  })

  test("on_exhausted goto is gone, with a message that says what to do instead", async () => {
    const dir = await tmpProject()
    const p = await writePack(dir, manifest([{ id: "l", type: "loop", until: { result: "c" }, max: 1, on_exhausted: { goto: "m", max: 1, then: "fail" }, steps: [{ id: "m", type: "skill", skill: "make", by: "worker", writes: [] }, { id: "c", type: "skill", skill: "check", by: "judge", writes: ["v.md"], result: { file: "v.md", field: "verdict" } }] }]), { agents: BASIC_AGENTS, skills: BASIC_SKILLS })
    await expect(loadPack(p)).rejects.toThrow(/goto was removed/)
  })

  test("scripts/ holds only .yml files; code belongs in scripts/scripts/", async () => {
    const dir = await tmpProject()
    const p = await writePack(dir, manifest([{ id: "chk", type: "script", script: "chk" }]), { agents: BASIC_AGENTS, skills: BASIC_SKILLS, scripts: { chk: { yml: { run: "bun $SLATE_PACK/scripts/scripts/chk.ts" }, code: "console.log('{}')" } } })
    expect((await validatePackDir(p)).ok).toBe(true)
    await Bun.write(`${p}/scripts/chk.cjs`, "")
    const r = await validatePackDir(p)
    expect(r.ok ? [] : r.problems).toContain("scripts/chk.cjs: only .yml files belong in scripts/; put script code in scripts/scripts/")
  })

  test("slate-core is never listed as a workflow pack", async () => {
    const packs = await listInstalledPacks()
    expect(packs.some((x) => x.name === "slate-core")).toBe(false)
    expect(packs.some((x) => x.name === "full-cycle-software-development")).toBe(true)
  })

  test("rejects an unknown config variable", async () => {
    const dir = await tmpProject()
    const p = await writePack(dir, manifest([{ id: "l", type: "loop", until: { script: "nope" }, max: "${nope}", steps: [{ id: "m", type: "skill", skill: "make", by: "worker", writes: [] }] }]))
    await expect(loadPack(p)).rejects.toThrow(/unknown config variable|not a known script/)
  })
})
