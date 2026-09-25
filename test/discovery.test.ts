import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { projectPaths } from "../src/config/paths.ts"
import { findPack } from "../src/pack/registry.ts"
import { checkDiscovery, discoveryDocs } from "../src/cli/discovery.ts"
import { createJob, runForeground } from "../src/cli/commands/run-job.ts"
import { Output } from "../src/cli/output.ts"
import { tmpProject, testConfig } from "./helpers.ts"

const SPECS = ["specs/product-scope.md", "specs/uiux-spec.md", "specs/tech-spec.md"]
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
    await write(root, { "specs/uiux-spec.md": "x", "specs/tech-spec.md": "x" })
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
