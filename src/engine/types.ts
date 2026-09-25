import type { AgentSpec, SkillSpec, ScriptSpec, Manifest, PermissionRule, ConsultPolicy, Gate, Step, PackPhase } from "../pack/schema.ts"
import type { ProjectConfig } from "../config/project.ts"

export type Phase = "intake" | PackPhase | "done"
export const PHASE_ORDER: Phase[] = ["intake", "discovery", "plan", "build", "close", "done"]

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export const EMPTY_TOKENS: TokenUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export interface LoadedPack {
  dir: string
  manifest: Manifest
  agents: Record<string, AgentSpec>
  skills: Record<string, SkillSpec>
  scripts: Record<string, ScriptSpec>
  /** Resolved config: manifest defaults overlaid with slate.config.yml `config`. */
  config: Record<string, unknown>
}

/** Everything the runtime needs to know about the job before any session exists. */
export interface JobContext {
  jobId: string
  root: string
  pack: LoadedPack
  project: ProjectConfig
  tier(t: "low" | "medium" | "high"): ModelRef
  /** Consult transcripts are written here: consults/{step}/{n}.md */
  consultsDir: string
  dbPath: string
  /** Live agent activity for `slate status` is written here. */
  activityPath: string
  /** The bundled slate-core pack: Slate's own agents, skills and prompt templates. */
  core: CorePack
}

/** slate-core is a normal pack plus `prompts/`: every text Slate itself sends a model. */
export interface CorePack extends LoadedPack {
  /** `prompts/<name>.md`: whole prompts. */
  prompts: Record<string, string>
  /** `prompts/messages.yml`: short texts agents read as tool results and permission decisions. */
  messages: Record<string, string>
}

export interface ResolvedGate extends Gate {}

export interface RunStepRequest {
  /** Unique execution key (step path + iteration/round). */
  key: string
  stepId: string
  agent: AgentSpec
  skill: SkillSpec
  model: ModelRef
  /** Session working directory (the job root or a task worktree). */
  directory: string
  /** Fully resolved prompt text. */
  prompt: string
  /** Absolute paths that exist and are attached to the prompt. */
  files: string[]
  /** Complete permission ruleset for the session, most specific first. */
  permissions: PermissionRule[]
  consult?: ConsultPolicy
  gates: ResolvedGate[]
  vars: Record<string, string>
  title: string
  timeoutMs: number
  /** Declared output contract (checked by the engine; also given to runtimes for audit and simulation). */
  contract?: { writes: string[]; result?: { file: string; field: string } }
  phase: string
  /** Called when the runtime observes a question the human must answer (permission ask or form). */
  onQuestion?: (q: RuntimeQuestion) => void
  /** Called by the runtime for every audit-worthy event in this step. */
  onAudit?: (event: AuditEvent) => void
  /** Optional synthetic follow-up messages the engine wants to send after a contract failure. */
  signal?: AbortSignal
}

export interface RuntimeQuestion {
  kind: "permission" | "form"
  sessionID: string
  requestID: string
  action?: string
  resources?: string[]
  message?: string
  title?: string
  fields?: unknown
  reviewerNotes?: string[]
}

export interface RunStepResult {
  sessionID: string
  outcome: "succeeded" | "failed" | "interrupted" | "timeout"
  cost: number
  tokens: TokenUsage
  model: ModelRef
  error?: { type: string; message: string; status?: number }
  /** Last assistant text, if any. */
  text?: string
  consults: number
}

export interface RepromptRequest {
  sessionID: string
  text: string
  timeoutMs: number
}

export interface ReviewRequest {
  reviewer: AgentSpec
  model: ModelRef
  prompt: string
  inputs: { path: string; content: string }[]
}

export interface WorktreeRequest {
  name: string
  sourceDirectory: string
}

export interface QuestionReply {
  sessionID: string
  requestID: string
  kind: "permission" | "form"
  decision: "once" | "always" | "reject"
  message?: string
  answer?: Record<string, string | number | boolean | string[]>
}

/**
 * The one boundary between Slate and the agent runtime. `OpenCodeRuntime` implements it with
 * `@opencode/sdk`; `FakeRuntime` implements it with scripted behaviors for tests and `--dry-run`.
 */
export interface Runtime {
  readonly kind: "opencode" | "fake"
  start(job: JobContext): Promise<void>
  close(): Promise<void>
  version(): string
  runStep(req: RunStepRequest): Promise<RunStepResult>
  reprompt(req: RepromptRequest): Promise<RunStepResult>
  interrupt(sessionID: string): Promise<void>
  /** Transient generation with no session, tools or history. Used for reviewers and decision agents. */
  review(req: ReviewRequest): Promise<string>
  reply(reply: QuestionReply): Promise<void>
  worktree: {
    create(req: WorktreeRequest): Promise<{ directory: string }>
    remove(directory: string): Promise<void>
  }
  /** Lists provider/model availability so `init` and `start` can fail early. */
  models(): Promise<{ providers: string[]; models: string[] }>
}

/* ---------------------------------- audit ---------------------------------- */

export type AuditEvent =
  | { type: "step.start"; key: string; step: string; branch: string; agent?: string; vars?: Record<string, string> }
  | { type: "step.end"; key: string; step: string; branch: string; status: StepStatus; sessionID?: string; cost?: number; reason?: string }
  | { type: "contract.failed"; key: string; step: string; missing: string[]; reason: string; reprompt: boolean }
  | { type: "infra.retry"; key: string; step: string; attempt: number; error: string }
  | { type: "consult"; key: string; step: string; consultant: string; n: number; verdict: string; file: string; sessionID?: string }
  | { type: "gate"; key: string; step: string; action: string; resource: string; decision: "allow" | "deny" | "ask"; reviewers: { id: string; decision: string; note?: string }[] }
  | { type: "verdict"; key: string; step: string; file: string; verdict: string }
  | { type: "loop.round"; key: string; loop: string; round: number; max: number }
  | { type: "loop.iteration"; key: string; loop: string; iteration: number; value: string }
  | { type: "loop.exhausted"; key: string; loop: string; policy: string }
  | { type: "question.open"; id: string; kind: string; branch: string; prompt: string }
  | { type: "question.answered"; id: string; answer: string; message?: string }
  | { type: "budget"; scope: string; spent: number; cap: number }
  | { type: "job"; status: string; phase?: Phase; reason?: string }
  | { type: "script"; key: string; script: string; ok: boolean; output?: string; error?: string }
  | { type: "worktree"; key: string; action: "create" | "remove"; directory: string }
  | { type: "session"; key: string; sessionID: string; agent: string; model: string; directory: string }
  | { type: "plan.revise"; note: string }

export interface AuditRecord {
  at: string
  seq: number
  job: string
  event: AuditEvent
}

/* ---------------------------------- state ---------------------------------- */

export type StepStatus = "running" | "passed" | "failed" | "interrupted"

export interface Attempt {
  n: number
  started: string
  finished?: string
  sessionID?: string
  outcome?: RunStepResult["outcome"]
  cost?: number
  model?: string
  failure?: string
  failureClass?: "contract" | "infra" | "timeout" | "script" | "rejected"
}

export interface StepRecord {
  key: string
  step: string
  type: Step["type"]
  branch: string
  vars: Record<string, string>
  status: StepStatus
  attempts: Attempt[]
  started: string
  finished?: string
  /** For result-bearing steps: the parsed verdict. */
  verdict?: string
  directory?: string
}

export interface LoopIteration {
  n: number
  value: string
  status: "running" | "done" | "failed" | "interrupted"
  branch: string
}

export interface LoopCursor {
  key: string
  loop: string
  kind: "over" | "until"
  iterations?: LoopIteration[]
  overDone?: boolean
  /** until: the round running now (or the one that would run next). */
  round?: number
  /** until: rounds granted beyond `max` by a retry answer or by `slate continue`. */
  extra?: number
  passed?: boolean
  skipped?: boolean
  exhausted?: boolean
}

export type QuestionKind = "approval" | "exhausted" | "permission" | "form" | "pack"

export interface QuestionOption {
  id: string
  label: string
  default?: boolean
}

export interface Question {
  id: string
  kind: QuestionKind
  prompt: string
  context: string[]
  options: QuestionOption[]
  /** The branch this question pauses. Every other branch keeps running. */
  branch: string
  stepKey?: string
  step?: string
  story?: string
  created: string
  answered?: { at: string; answer: string; message?: string; by: "human" | "decision-agent" | "timeout" }
  sessionID?: string
  requestID?: string
  reviewerNotes?: string[]
  freeText?: boolean
}

export interface Spend {
  total: number
  byModel: Record<string, number>
  byAgent: Record<string, number>
  byStep: Record<string, number>
  byTask: Record<string, number>
  byStory: Record<string, number>
  tokens: TokenUsage
}

export interface BranchInfo {
  id: string
  story?: string
  status: "running" | "blocked" | "done" | "failed" | "idle"
  current?: string
  blockedOn?: string
  since: string
}

export type JobStatus = "running" | "stopped" | "blocked" | "done" | "failed"

export interface JobState {
  version: 1
  job: {
    id: string
    name: string
    created: string
    pack?: { name: string; version: string; dir: string }
    opencode: string
    runtime: "opencode" | "fake"
    idea?: string
    /** Chosen at `slate start`; unattended answers every question that has a default. */
    autonomy?: "supervised" | "unattended"
  }
  phase: Phase
  status: JobStatus
  stopReason?: string
  config: Record<string, unknown>
  vars: Record<string, string>
  loops: Record<string, LoopCursor>
  steps: Record<string, StepRecord>
  questions: Question[]
  spend: Spend
  branches: Record<string, BranchInfo>
  contractFailures: { key: string; step: string; missing: string[]; at: string; retried: boolean }[]
  planRevisions: number
  updated: string
}

export function emptySpend(): Spend {
  return { total: 0, byModel: {}, byAgent: {}, byStep: {}, byTask: {}, byStory: {}, tokens: { ...EMPTY_TOKENS, cache: { read: 0, write: 0 } } }
}

export function newJobState(input: { id: string; name: string; opencode: string; runtime: "opencode" | "fake"; idea?: string }): JobState {
  const now = new Date().toISOString()
  return {
    version: 1,
    job: { id: input.id, name: input.name, created: now, opencode: input.opencode, runtime: input.runtime, idea: input.idea },
    phase: "intake",
    status: "running",
    config: {},
    vars: {},
    loops: {},
    steps: {},
    questions: [],
    spend: emptySpend(),
    branches: {},
    contractFailures: [],
    planRevisions: 0,
    updated: now,
  }
}

/* --------------------------------- signals --------------------------------- */

/** The job halts cleanly: everything finished is checkpointed and `slate continue` picks up from there. */
export class StopSignal extends Error {
  constructor(public readonly now: boolean, message = "stop requested") {
    super(message)
    this.name = "StopSignal"
  }
}

/** Work failed and no enclosing `until` loop can retry it. `slate continue` re-runs what failed. */
export class JobFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JobFailed"
  }
}

