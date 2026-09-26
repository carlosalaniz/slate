import path from "node:path"
import type { Runtime, JobContext, RunStepRequest, RunStepResult, RepromptRequest, ReviewRequest, QuestionReply, WorktreeRequest, ModelRef, McpServerSpec } from "../engine/types.ts"
import { resolveRuntime } from "../engine/vars.ts"
import { writeText, ensureDir, copyDir, removePath, isDir } from "../util/fs.ts"
import { stringifyFrontmatter } from "../util/frontmatter.ts"
import { addWorktree, isGitRoot, removeWorktree } from "../util/git.ts"

export interface FakeBehavior {
  /** Return true to skip the default contract-satisfying writes (simulates a silent no-op). */
  run?: (req: RunStepRequest, n: number) => Promise<Partial<RunStepResult> & { skipWrites?: boolean; verdict?: "pass" | "fail" | string; cost?: number }> | (Partial<RunStepResult> & { skipWrites?: boolean; verdict?: "pass" | "fail" | string; cost?: number })
}

export interface FakeOptions {
  /** Behaviors keyed by step id; `*` matches everything. */
  behaviors?: Record<string, FakeBehavior>
  /** Reviewer answers keyed by reviewer agent id (default approve with a citation). */
  reviews?: Record<string, string | ((req: ReviewRequest) => string)>
  costPerStep?: number
  delayMs?: number
  worktrees?: "copy" | "none"
  /** Modalities per model id (e.g. "fake-low"); default: every model accepts and produces everything. */
  modalities?: Record<string, { input: string[]; output: string[] } | undefined>
  /** MCP status per server name; default connected. */
  mcp?: Record<string, { status: string; error?: string }>
}

/**
 * A runtime with no model. Each skill step "runs" by writing the files the contract demands,
 * so a whole job can be executed end to end in a test or a `--dry-run`. Behaviors let tests
 * simulate missing verdicts, failing checks and infra errors.
 */
export class FakeRuntime implements Runtime {
  readonly kind = "fake" as const
  private job!: JobContext
  private counts = new Map<string, number>()
  public readonly calls: { step: string; key: string; agent: string; model: string; directory: string; prompt: string; permissions: RunStepRequest["permissions"] }[] = []
  public readonly reprompts: string[] = []
  public readonly reviewsMade: ReviewRequest[] = []
  public readonly replies: QuestionReply[] = []
  public readonly mcpServers: McpServerSpec[] = []

  constructor(private readonly opts: FakeOptions = {}) {}

  async start(job: JobContext): Promise<void> {
    this.job = job
  }
  async close(): Promise<void> {}
  version(): string {
    return "fake"
  }

  async models() {
    return { providers: ["fake"], models: ["fake/low", "fake/medium", "fake/high"] }
  }

  async modelModalities(model: ModelRef) {
    const all = ["text", "image", "audio", "video", "pdf"]
    if (this.opts.modalities && model.id in this.opts.modalities) return this.opts.modalities[model.id]
    return { input: all, output: all }
  }

  async ensureMcp(servers: McpServerSpec[]): Promise<void> {
    for (const s of servers) if (!this.mcpServers.some((x) => x.name === s.name)) this.mcpServers.push(s)
  }

  async mcpStatus(names: string[]) {
    const out: Record<string, { status: string; error?: string }> = {}
    for (const n of names) out[n] = this.opts.mcp?.[n] ?? (this.mcpServers.some((s) => s.name === n) ? { status: "connected" } : { status: "missing" })
    return out
  }

  private behaviorFor(stepId: string): FakeBehavior | undefined {
    return this.opts.behaviors?.[stepId] ?? this.opts.behaviors?.["*"]
  }

  async runStep(req: RunStepRequest): Promise<RunStepResult> {
    const n = (this.counts.get(req.stepId) ?? 0) + 1
    this.counts.set(req.stepId, n)
    this.calls.push({ step: req.stepId, key: req.key, agent: req.agent.id, model: req.model.id, directory: req.directory, prompt: req.prompt, permissions: req.permissions })
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs))
    const behavior = this.behaviorFor(req.stepId)
    const custom = behavior?.run ? await behavior.run(req, n) : {}
    const sessionID = `fake_${req.stepId}_${n}_${Math.random().toString(36).slice(2, 6)}`
    if (!custom.skipWrites) await this.satisfy(req, custom.verdict ?? "pass")
    return {
      sessionID,
      outcome: custom.outcome ?? "succeeded",
      cost: custom.cost ?? this.opts.costPerStep ?? 0.01,
      tokens: custom.tokens ?? { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      model: req.model,
      error: custom.error,
      text: custom.text ?? `fake ${req.stepId} done`,
      consults: 0,
    }
  }

  /** Writes every declared output. Result files get frontmatter with the verdict. */
  private async satisfy(req: RunStepRequest, verdict: string): Promise<void> {
    const meta = (req as RunStepRequest & { contract?: { writes: string[]; result?: { file: string; field: string } } }).contract
    const writes = meta?.writes ?? []
    const result = meta?.result
    for (const w of writes) {
      const rel = resolveRuntime(w, req.vars)
      const abs = path.resolve(req.directory, rel)
      if (result && resolveRuntime(result.file, req.vars) === rel) {
        await writeText(abs, stringifyFrontmatter({ [result.field]: verdict, step: req.stepId, agent: req.agent.id }, `\n# ${req.stepId}\n\nfake output by ${req.agent.id}\n`))
      } else if (rel.endsWith(".yaml") || rel.endsWith(".yml")) {
        await writeText(abs, fakeYaml(rel, req))
      } else {
        await writeText(abs, `# ${rel}\n\nfake output for ${req.stepId} by ${req.agent.id}\nvars: ${JSON.stringify(req.vars)}\n`)
      }
    }
  }

  async reprompt(req: RepromptRequest): Promise<RunStepResult> {
    this.reprompts.push(req.text)
    return { sessionID: req.sessionID, outcome: "succeeded", cost: 0.001, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, model: { providerID: "fake", id: "fake" }, consults: 0 }
  }

  async interrupt(): Promise<void> {}

  async review(req: ReviewRequest): Promise<string> {
    this.reviewsMade.push(req)
    const r = this.opts.reviews?.[req.reviewer.id]
    if (typeof r === "function") return r(req)
    if (typeof r === "string") return r
    return "decision: approve\ncite: line 1\nnote: looks fine"
  }

  async reply(reply: QuestionReply): Promise<void> {
    this.replies.push(reply)
  }

  worktree = {
    create: async (req: WorktreeRequest): Promise<{ directory: string }> => {
      const dir = path.join(this.job.root, ".slate", "worktrees", req.name)
      // Real git worktrees when the step needs a branch to merge, as in the OpenCode runtime.
      if (req.gitOnly) {
        if (!(await isGitRoot(req.sourceDirectory))) return { directory: req.sourceDirectory }
        if (await isDir(dir)) return { directory: dir }
        const error = await addWorktree(req.sourceDirectory, dir, req.name)
        if (error) throw new Error(error)
        return { directory: dir }
      }
      await ensureDir(dir)
      if ((this.opts.worktrees ?? "copy") === "copy") {
        await copyDir(req.sourceDirectory, dir)
        await removePath(path.join(dir, ".slate"))
      }
      return { directory: dir }
    },
    remove: async (directory: string): Promise<void> => {
      if (await isGitRoot(this.job.root)) await removeWorktree(this.job.root, directory)
      else await removePath(directory)
    },
  }
}

function fakeYaml(rel: string, req: RunStepRequest): string {
  const base = path.basename(rel)
  if (base === "index.yaml" && rel.startsWith("stories")) {
    return ["stories:", "  - id: s1", "    title: First story", "  - id: s2", "    title: Second story", "    depends_on: [s1]", ""].join("\n")
  }
  if (base === "graph.yaml") {
    return ["nodes:", "  s1: []", "  s2: [s1]", ""].join("\n")
  }
  if (base === "tasks.yaml") {
    const story = req.vars.story ?? "s"
    return ["tasks:", `  - id: ${story}-t1`, "    title: First task", "    scope: { modify: ['src/a/**'] }", `  - id: ${story}-t2`, "    title: Second task", "    scope: { modify: ['src/b/**'] }", ""].join("\n")
  }
  return `# ${rel}\nfake: true\nstep: ${req.stepId}\n`
}

export function fakeModel(tier: string): ModelRef {
  return { providerID: "fake", id: `fake-${tier}` }
}
