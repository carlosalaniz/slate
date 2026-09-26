import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import YAML from "yaml"
import { projectPaths } from "../src/config/paths.ts"
import { ProjectConfigSchema, type ProjectConfig } from "../src/config/project.ts"
import { StateStore } from "../src/engine/state.ts"
import { AuditLog } from "../src/engine/audit.ts"
import { Engine, type EngineOptions } from "../src/engine/engine.ts"
import { newJobState } from "../src/engine/types.ts"
import { loadPack } from "../src/pack/loader.ts"
import { FakeRuntime, type FakeOptions } from "../src/opencode/fake.ts"
import { bundledPacksDir } from "../src/config/paths.ts"

export async function tmpProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slate-test-"))
  await mkdir(path.join(dir, ".slate"), { recursive: true })
  return dir
}

/** Tests never launch a browser or fetch the Playwright MCP server: playwright is waived unless a test says otherwise. */
export function testConfig(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return ProjectConfigSchema.parse({ name: "t", capabilities: { waive: ["playwright"] }, budget: { job: 1000, per_task: 100, per_model: {} }, autonomy: { question_timeout_hours: 0, on_timeout: "keep-waiting", auto_approve: false }, runtime: { worktrees: "none", step_timeout_minutes: 1, infra_retries: 1, contract_reprompts: 1 }, ...over })
}

/** Writes a minimal pack into dir/pack and returns its path. Script code goes to scripts/scripts/<id>.ts. */
export async function writePack(dir: string, manifest: Record<string, unknown>, files: { agents?: Record<string, unknown>; skills?: Record<string, unknown>; scripts?: Record<string, { yml: unknown; code?: string }> } = {}): Promise<string> {
  const pack = path.join(dir, "pack")
  await mkdir(path.join(pack, "agents"), { recursive: true })
  await mkdir(path.join(pack, "skills"), { recursive: true })
  await mkdir(path.join(pack, "scripts", "scripts"), { recursive: true })
  await writeFile(path.join(pack, "slate-pack.yml"), YAML.stringify(manifest))
  for (const [id, a] of Object.entries(files.agents ?? {})) await writeFile(path.join(pack, "agents", `${id}.yml`), YAML.stringify(a))
  for (const [id, s] of Object.entries(files.skills ?? {})) await writeFile(path.join(pack, "skills", `${id}.yml`), YAML.stringify(s))
  for (const [id, s] of Object.entries(files.scripts ?? {})) {
    await writeFile(path.join(pack, "scripts", `${id}.yml`), YAML.stringify(s.yml))
    if (s.code) await writeFile(path.join(pack, "scripts", "scripts", `${id}.ts`), s.code)
  }
  return pack
}

export const BASIC_AGENTS = {
  worker: { description: "w", role: "worker", model: "low", scope: { modify: ["**"] }, prompt: "do it" },
  judge: { description: "j", role: "worker", model: "medium", scope: { modify: ["**"] }, prompt: "judge" },
  advisor: { description: "a", role: "consultant", model: "high", scope: { read: ["**"] }, prompt: "advise" },
  owner: { description: "o", role: "reviewer", model: "low", prompt: "review" },
}
export const BASIC_SKILLS = {
  make: { description: "make", reads: [], prompt: "make {story} {task} round {round}" },
  check: { description: "check", reads: [], prompt: "check" },
}

export interface Harness {
  root: string
  engine: Engine
  runtime: FakeRuntime
  store: StateStore
  pack: string
}

export async function harness(input: { manifest: Record<string, unknown>; files?: Parameters<typeof writePack>[2]; fake?: FakeOptions; config?: Partial<ProjectConfig>; engine?: Partial<EngineOptions>; brief?: string; idea?: string; usePackDir?: string }): Promise<Harness> {
  const root = await tmpProject()
  const packDir = input.usePackDir ?? (await writePack(root, input.manifest, input.files ?? { agents: BASIC_AGENTS, skills: BASIC_SKILLS }))
  const paths = projectPaths(root)
  const pack = await loadPack(packDir)
  const config = testConfig(input.config)
  await writeFile(paths.brief, input.brief ?? "---\ntitle: test\n---\n# Goal\nbuild the thing\n")
  const state = newJobState({ id: "job1", name: "t", opencode: "fake", runtime: "fake", idea: input.idea })
  state.job.pack = { name: pack.manifest.name, version: pack.manifest.version, dir: packDir }
  const store = await StateStore.create(paths.state, state)
  const audit = await AuditLog.open(paths.log, "job1")
  const runtime = new FakeRuntime(input.fake)
  const engine = new Engine({ root, paths, runtime, project: config, state: store, audit, installedPacks: [], pack, autoApprove: true, pollMs: 15, log: () => undefined, ...input.engine })
  return { root, engine, runtime, store, pack: packDir }
}

export function referencePackDir(): string {
  return path.join(bundledPacksDir(), "full-cycle-software-development")
}
