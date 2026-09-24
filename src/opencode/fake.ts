import path from "node:path"
import type { Runtime, JobContext, RunStepRequest, RunStepResult, RepromptRequest, ReviewRequest, QuestionReply, WorktreeRequest, ModelRef } from "../engine/types.ts"
import { resolveRuntime } from "../engine/vars.ts"
import { writeText, ensureDir, copyDir, removePath } from "../util/fs.ts"
import { stringifyFrontmatter } from "../util/frontmatter.ts"

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
  public readonly calls: { step: string; key: string; agent: string; model: string; directory: string; prompt: string }[] = []
  public readonly reprompts: string[] = []
  public readonly reviewsMade: ReviewRequest[] = []
  public readonly replies: QuestionReply[] = []

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

  private behaviorFor(stepId: string): FakeBehavior | undefined {
    return this.opts.behaviors?.[stepId] ?? this.opts.behaviors?.["*"]
  }

  async runStep(req: RunStepRequest): Promise<RunStepResult> {
    const n = (this.counts.get(req.stepId) ?? 0) + 1
    this.counts.set(req.stepId, n)
    this.calls.push({ step: req.stepId, key: req.key, agent: req.agent.id, model: req.model.id, directory: req.directory, prompt: req.prompt })
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
      await ensureDir(dir)
      if ((this.opts.worktrees ?? "copy") === "copy") {
        await copyDir(req.sourceDirectory, dir)
        await removePath(path.join(dir, ".slate"))
      }
      return { directory: dir }
    },
    remove: async (directory: string): Promise<void> => {
      await removePath(directory)
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
