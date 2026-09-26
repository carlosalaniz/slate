import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { projectPaths } from "../src/config/paths.ts"
import { findPack } from "../src/pack/registry.ts"
import YAML from "yaml"
import { checkDiscovery, discoveryDocs, writeCoreLead, writePackAgents, scaffoldDocs, discoveryFiles, archiveDiscovery } from "../src/cli/discovery.ts"
import { loadCorePack } from "../src/engine/core-pack.ts"
import { createJob, runForeground, buildEngine } from "../src/cli/commands/run-job.ts"
import { Output } from "../src/cli/output.ts"
import { tmpProject, testConfig } from "./helpers.ts"

const SPECS = ["specs/product-scope.md", "specs/uiux-spec.md", "specs/tech-spec.md", "specs/capabilities.yaml"]
const brief = (pack?: string) => `---\ntitle: Kids calculator\nkind: software\n${pack ? `pack: ${pack}\n` : ""}---\n# Goal\nA whimsical calculator game.\n`

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [f, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, f)), { recursive: true })
    await writeFile(path.join(root, f), text)
  }
}

describe("discovery", () => {
  test("the reference pack asks for its three discovery specs, with their instructions", async () => {
    const pack = (await findPack("full-cycle-software-development"))!
    const docs = await discoveryDocs(pack)
    expect(docs.map((d) => d.file)).toEqual(SPECS)
    expect(docs.every((d) => d.instructions.length > 0)).toBe(true)
  })

  test("is done only when the brief names an installed pack and its documents exist", async () => {
    const root = await tmpProject()
    const paths = projectPaths(root)
    expect(await checkDiscovery(paths)).toMatchObject({ done: false, missing: [".slate/brief.md"] })
    await write(root, { ".slate/brief.md": brief() })
    expect((await checkDiscovery(paths)).missing[0]).toContain("pack:")
    await write(root, { ".slate/brief.md": brief("no-such-pack") })
    expect((await checkDiscovery(paths)).missing[0]).toContain("no-such-pack")
    await write(root, { ".slate/brief.md": brief("full-cycle-software-development"), "specs/product-scope.md": "x" })
    expect(await checkDiscovery(paths)).toMatchObject({ done: false, missing: SPECS.slice(1) })
    await write(root, { "specs/uiux-spec.md": "x", "specs/tech-spec.md": "x", "specs/capabilities.yaml": "needs: []" })
    const done = await checkDiscovery(paths)
    expect(done.done).toBe(true)
    expect(done.pack!.name).toBe("full-cycle-software-development")
  })

  test("a job from a finished discovery starts at plan and never reruns intake or discovery", async () => {
    const root = await tmpProject()
    const paths = projectPaths(root)
    await write(root, { ".slate/brief.md": brief("full-cycle-software-development"), ...Object.fromEntries(SPECS.map((f) => [f, "written with the user\n"])) })
    const p = { root, paths, config: testConfig({ config: { max_stories: 2 }, runtime: { worktrees: "copy", step_timeout_minutes: 1, infra_retries: 1, contract_reprompts: 1 } }) }
    const check = await checkDiscovery(paths)
    const opts = { dryRun: true, autoApprove: true, quiet: true }
    const store = await createJob(p, { ...opts, discovered: check.pack })
    expect(store.get().phase).toBe("plan")
    const st = await runForeground(p, store, opts, new Output(true))
    expect(st.status).toBe("done")
    const ran = Object.values(st.steps).map((s) => s.key)
    expect(ran.some((k) => k.startsWith("intake/") || k.startsWith("discovery/"))).toBe(false)
    expect(ran.some((k) => k.startsWith("plan/"))).toBe(true)
    // the specs written with the user are left alone
    expect(await Bun.file(path.join(root, "specs/tech-spec.md")).text()).toBe("written with the user\n")
  }, 120_000)
})

describe("discovery agents and placeholders", () => {
  const frontOf = async (file: string) => {
    const text = await Bun.file(file).text()
    return { data: YAML.parse(/^---\n([\s\S]*?)\n---/.exec(text)![1]!), body: text.replace(/^---\n[\s\S]*?\n---\n/, "") }
  }
  const config = testConfig({ provider: "openrouter", models: { low: "a/low", medium: "a/mid", high: "a/high" } })

  test("the core lead only asks what to build and which installed pack; it writes the brief only", async () => {
    const root = await tmpProject()
    const paths = projectPaths(root)
    await writeCoreLead(paths, config, await loadCorePack())
    const lead = await frontOf(path.join(root, ".opencode/agents/slate-discovery.md"))
    expect(lead.data).toMatchObject({ mode: "primary", model: "openrouter/a/high" })
    expect(lead.data.permissions).toContainEqual({ action: "edit", resource: ".slate/brief.md", effect: "allow" })
    expect(lead.data.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    // The pack question can only offer installed packs, with their own fits line.
    expect(lead.body).toContain("- label: full-cycle-software-development\n     description: Building or extending a software product")
    // No pack's specialists are written until a pack is chosen.
    expect(await Bun.file(path.join(root, ".opencode/agents/slate-analyst.md")).exists()).toBe(false)
  })

  test("the chosen pack's lead gets the pack's prompt plus Slate's rules; specialists stay in scope", async () => {
    const root = await tmpProject()
    const paths = projectPaths(root)
    const pack = (await findPack("full-cycle-software-development"))!
    const { lead, docs } = await writePackAgents(paths, config, await loadCorePack(), pack)
    expect(lead).toBe("slate-full-cycle-software-development")
    expect(docs.map((d) => [d.file, d.subagent])).toEqual([["specs/product-scope.md", "slate-analyst"], ["specs/uiux-spec.md", "slate-uiux-designer"], ["specs/tech-spec.md", "slate-architect"], ["specs/capabilities.yaml", "slate-architect"]])

    const packLead = await frontOf(path.join(root, `.opencode/agents/${lead}.md`))
    expect(packLead.data).toMatchObject({ mode: "primary", model: "openrouter/a/high" })
    expect(packLead.data.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "allow" })
    expect(packLead.data.permissions).toContainEqual({ action: "edit", resource: ".slate/brief.md", effect: "allow" })
    expect(packLead.body).toContain("You are the discovery lead for a software product") // the pack's own prompt
    expect(packLead.body).toContain("`specs/product-scope.md`: subagent `slate-analyst`") // Slate's rules

    const analyst = await frontOf(path.join(root, ".opencode/agents/slate-analyst.md"))
    expect(analyst.data.mode).toBe("subagent")
    expect(analyst.data.permissions).toContainEqual({ action: "question", resource: "*", effect: "deny" })
    expect(analyst.data.permissions).toContainEqual({ action: "edit", resource: "specs/**", effect: "allow" })
  })

  test("placeholders fill the missing documents and still count as missing", async () => {
    const root = await tmpProject()
    const paths = projectPaths(root)
    const core = await loadCorePack()
    const { docs } = await writePackAgents(paths, testConfig(), core, (await findPack("full-cycle-software-development"))!)
    await write(root, { ".slate/brief.md": brief("full-cycle-software-development"), "specs/tech-spec.md": "already written\n" })
    await scaffoldDocs(paths, docs, core)
    expect(await Bun.file(path.join(root, "specs/product-scope.md")).text()).toContain("slate-analyst")
    expect(await Bun.file(path.join(root, "specs/tech-spec.md")).text()).toBe("already written\n")
    expect(await checkDiscovery(paths)).toMatchObject({ done: false, missing: [...SPECS.slice(0, 2), SPECS[3]] })
  })
})

describe("autonomy", () => {
  test("the choice made at start is saved with the job, so a resumed job keeps it", async () => {
    const root = await tmpProject()
    const p = { root, paths: projectPaths(root), config: testConfig() }
    const store = await createJob(p, { dryRun: true, autoApprove: true, quiet: true, idea: "x" })
    expect(store.get().job.autonomy).toBe("unattended")
    // `slate continue` passes no --yes; the saved autonomy still auto-approves.
    const engine = await buildEngine(p, store, { dryRun: true, autoApprove: false, quiet: true }, new Output(true))
    expect(engine.o.autoApprove).toBe(true)
  })
})

describe("starting discovery over", () => {
  test("archives the brief and written documents, drops placeholders, and leaves nothing behind", async () => {
    const root = await tmpProject()
    const paths = projectPaths(root)
    const core = await loadCorePack()
    const { docs } = await writePackAgents(paths, testConfig(), core, (await findPack("full-cycle-software-development"))!)
    await write(root, { ".slate/brief.md": brief("full-cycle-software-development"), "specs/product-scope.md": "written with the user\n" })
    await scaffoldDocs(paths, docs, core) // uiux-spec and tech-spec become placeholders
    // What "start over" lists for confirmation: the person's work, not Slate's placeholders.
    expect(await discoveryFiles(paths)).toEqual([".slate/brief.md", "specs/product-scope.md"])

    const dir = (await archiveDiscovery(paths))!
    expect(dir).toContain(".slate/archive/discovery-")
    expect(await Bun.file(path.join(dir, "specs/product-scope.md")).text()).toBe("written with the user\n")
    expect(await Bun.file(path.join(dir, ".slate/brief.md")).exists()).toBe(true)
    // Placeholders were Slate's, not the person's: removed, not archived.
    expect(await Bun.file(path.join(dir, "specs/tech-spec.md")).exists()).toBe(false)
    for (const f of [".slate/brief.md", ...SPECS]) expect(await Bun.file(path.join(root, f)).exists()).toBe(false)
    expect(await checkDiscovery(paths)).toMatchObject({ done: false, missing: [".slate/brief.md"] })
  })
})
