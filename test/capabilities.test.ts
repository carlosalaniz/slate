import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import YAML from "yaml"
import { harness, tmpProject, writePack, BASIC_AGENTS, BASIC_SKILLS } from "./helpers.ts"
import { loadPack, PackError } from "../src/pack/loader.ts"
import type { FakeOptions } from "../src/opencode/fake.ts"
import type { ProjectConfig } from "../src/config/project.ts"

/** A capability whose free check answers ok or not, with an optional MCP server. */
function capability(ok: boolean, mcp = false) {
  return {
    yml: { description: "a browser", check: "bun $SLATE_PACK/capabilities/scripts/probe.ts", install: "install the browser", ...(mcp ? { mcp: { command: ["probe-mcp", "--stdio"] } } : {}) },
    code: `console.log(JSON.stringify(${ok ? `{ ok: true, mcp: process.env.SLATE_MCP_COMMAND ?? null }` : `{ ok: false, reason: "no browser here" }`}))`,
  }
}

async function packWith(input: {
  agents?: Record<string, unknown>
  skills?: Record<string, unknown>
  build?: unknown[]
  capability?: { yml: unknown; code: string }
  extra?: Record<string, unknown>
}): Promise<string> {
  const dir = await tmpProject()
  const manifest = { slate: 1, name: "p", version: "0.1.0", config: { on_exhausted: "fail" }, phases: { discovery: [], plan: [], build: input.build ?? [{ id: "look", type: "skill", skill: "make", by: "worker", writes: ["out/look.md"] }], close: [] }, ...input.extra }
  const pack = await writePack(dir, manifest, { agents: { ...BASIC_AGENTS, ...input.agents }, skills: { ...BASIC_SKILLS, ...input.skills } })
  if (input.capability) {
    await mkdir(path.join(pack, "capabilities", "scripts"), { recursive: true })
    await writeFile(path.join(pack, "capabilities", "probe.yml"), YAML.stringify(input.capability.yml))
    await writeFile(path.join(pack, "capabilities", "scripts", "probe.ts"), input.capability.code)
  }
  return pack
}

const run = async (pack: string, opts: { fake?: FakeOptions; config?: Partial<ProjectConfig>; files?: Record<string, string> } = {}) => {
  const h = await harness({ manifest: {}, usePackDir: pack, fake: opts.fake, config: opts.config })
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    await mkdir(path.dirname(path.join(h.root, rel)), { recursive: true })
    await writeFile(path.join(h.root, rel), text)
  }
  return { h, st: await h.engine.run() }
}

const worker = (requires: unknown) => ({ worker: { ...BASIC_AGENTS.worker, requires } })

describe("requirements: loading", () => {
  test("an unknown tool is a pack error; slate-core's playwright is known to every pack", async () => {
    await expect(loadPack(await packWith({ agents: worker({ tools: ["nope"] }) }))).rejects.toThrow(/requires unknown tool 'nope'/)
    const pack = await loadPack(await packWith({ skills: { make: { ...BASIC_SKILLS.make, requires: { tools: ["playwright"], model: { input: ["image"] } } } } }))
    expect(pack.capabilities.playwright?.mcp?.command).toContain("@playwright/mcp@latest")
    expect(pack.skills.make!.requires).toEqual({ tools: ["playwright"], model: { input: ["image"], output: [] }, env: [] })
  })

  test("capability code belongs in capabilities/scripts/", async () => {
    const pack = await packWith({})
    await mkdir(path.join(pack, "capabilities"), { recursive: true })
    await writeFile(path.join(pack, "capabilities", "probe.ts"), "")
    const err = await loadPack(pack).catch((e) => e as PackError)
    expect((err as PackError).problems).toContain("capabilities/probe.ts: only .yml files belong in capabilities/; put script code in capabilities/scripts/")
  })
})

describe("requirements: preflight before any work", () => {
  test("a tool whose check fails halts the job before any step runs, with the fix; continue checks again", async () => {
    const pack = await packWith({ agents: worker({ tools: ["probe"] }), capability: capability(false) })
    const { h, st } = await run(pack)
    expect(st.status).toBe("stopped")
    expect(st.stopReason).toContain("tool 'probe' is not available: no browser here")
    expect(st.stopReason).toContain("build/look (agent worker, skill make)")
    expect(st.stopReason).toContain("Fix: install the browser")
    expect(st.stopReason).toContain("capabilities.waive")
    expect(h.runtime.calls).toHaveLength(0)
    const log = (await readFile(path.join(h.root, ".slate", "log.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l).event)
    expect(log.find((e) => e.type === "preflight")).toMatchObject({ ok: false })
  })

  test("waiving the tool runs the job and tells the agent it is unavailable", async () => {
    const pack = await packWith({ agents: worker({ tools: ["probe"] }), capability: capability(false) })
    const { h, st } = await run(pack, { config: { capabilities: { waive: ["probe"] } } })
    expect(st.status).toBe("done")
    expect(h.runtime.calls[0]!.prompt).toContain("Not available in this job, by the person's choice: probe.")
  })

  test("a model that cannot take the required input halts the job; waiving the modality lets it run", async () => {
    const pack = await packWith({ skills: { make: { ...BASIC_SKILLS.make, requires: { model: { input: ["image"] } } } } })
    const fake: FakeOptions = { modalities: { "fake-low": { input: ["text"], output: ["text"] } } }
    const halted = await run(pack, { fake })
    expect(halted.st.status).toBe("stopped")
    expect(halted.st.stopReason).toContain("model fake/fake-low (tier low) does not accept image")
    expect(halted.st.stopReason).toContain("waive 'image-input'")
    const waived = await run(pack, { fake, config: { capabilities: { waive: ["image-input"] } } })
    expect(waived.st.status).toBe("done")
  })

  test("an MCP tool is registered, checked, and callable only by the agents and skills that require it", async () => {
    const pack = await packWith({
      agents: worker({ tools: ["probe"] }),
      build: [
        { id: "look", type: "skill", skill: "make", by: "worker", writes: ["out/look.md"] },
        { id: "judge", type: "skill", skill: "check", by: "judge", writes: ["out/judge.md"] },
      ],
      capability: capability(true, true),
    })
    const { h, st } = await run(pack)
    expect(st.status).toBe("done")
    expect(h.runtime.mcpServers.map((s) => s.name)).toEqual(["probe"])
    const last = (rules: { action: string; effect: string }[]) => rules.findLast((r) => r.action === "probe_*")?.effect
    expect(last(h.runtime.calls.find((c) => c.step === "look")!.permissions)).toBe("allow")
    expect(last(h.runtime.calls.find((c) => c.step === "judge")!.permissions)).toBe("deny")
    expect(h.runtime.calls.find((c) => c.step === "look")!.prompt).toContain("Tools you have for this step (their tool names start with the tool id): probe.")
    expect(h.runtime.calls.find((c) => c.step === "judge")!.prompt).not.toContain("Tools you have")
  })

  test("an MCP server that does not connect halts the job", async () => {
    const pack = await packWith({ agents: worker({ tools: ["probe"] }), capability: capability(true, true) })
    const { st } = await run(pack, { fake: { mcp: { probe: { status: "failed", error: "spawn probe-mcp ENOENT" } } } })
    expect(st.status).toBe("stopped")
    expect(st.stopReason).toContain("its MCP server (probe-mcp --stdio) is failed: spawn probe-mcp ENOENT")
  })
})

describe("requirements: what discovery says the product needs", () => {
  const needsPack = (extra: Record<string, unknown> = {}) =>
    packWith({
      extra: { needs: "specs/capabilities.yaml" },
      skills: { "make-sounds": { description: "Synthesizes speech clips", requires: { tools: ["probe"] }, prompt: "make sounds" }, ...extra },
      capability: capability(true, true),
    })
  const needs = (list: unknown[]) => ({ "specs/capabilities.yaml": YAML.stringify({ needs: list }) })

  test("a need nothing installed covers halts the job before planning; waiving it lets the job go on", async () => {
    const pack = await needsPack()
    const files = needs([{ id: "audio-synthesis", for: "47 spoken clips in EN and ES" }])
    const halted = await run(pack, { files })
    expect(halted.st.status).toBe("stopped")
    expect(halted.st.stopReason).toContain("Nothing installed covers need 'audio-synthesis' (47 spoken clips in EN and ES) in specs/capabilities.yaml")
    expect(halted.st.stopReason).toContain("waive 'audio-synthesis'")
    expect(halted.h.runtime.calls).toHaveLength(0)
    const waived = await run(pack, { files, config: { capabilities: { waive: ["audio-synthesis"] } } })
    expect(waived.st.status).toBe("done")
  })

  test("a need mapped to an installed skill gives every worker that skill's tools", async () => {
    const pack = await needsPack()
    const { h, st } = await run(pack, { files: needs([{ id: "audio-synthesis", for: "spoken clips", skill: "make-sounds" }]) })
    expect(st.status).toBe("done")
    expect(h.runtime.mcpServers.map((s) => s.name)).toEqual(["probe"])
    expect(h.runtime.calls[0]!.permissions.findLast((r) => r.action === "probe_*")?.effect).toBe("allow")
  })

  test("a need naming a skill that is not installed halts; a missing needs file halts too", async () => {
    const pack = await needsPack()
    const unknown = await run(pack, { files: needs([{ id: "audio-synthesis", skill: "tts" }]) })
    expect(unknown.st.stopReason).toContain("names skill 'tts', which is not installed")
    const missing = await run(pack)
    expect(missing.st.status).toBe("stopped")
    expect(missing.st.stopReason).toContain("specs/capabilities.yaml is missing")
  })

  test("the installed skills and tools are listed for discovery in .slate/capabilities.md", async () => {
    const pack = await needsPack()
    const { h } = await run(pack, { files: needs([]) })
    const text = await readFile(path.join(h.root, ".slate", "capabilities.md"), "utf8")
    expect(text).toContain("- `make-sounds`: Synthesizes speech clips (tools: probe)")
    expect(text).toContain("- `playwright`:")
  })
})
