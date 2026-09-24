import type { ProjectConfig } from "../config/project.ts"
import type { ProjectPaths } from "../config/paths.ts"
import type { InstalledPack } from "../pack/registry.ts"
import type { StateStore } from "./state.ts"
import type { AuditLog } from "./audit.ts"
import type { JobState, LoadedPack, Phase, Question, Runtime } from "./types.ts"

/**
 * job — the shapes every engine file shares: options, the per-branch context, and step results.
 */

export interface EngineOptions {
  root: string
  paths: ProjectPaths
  runtime: Runtime
  project: ProjectConfig
  state: StateStore
  audit: AuditLog
  installedPacks: InstalledPack[]
  pack?: LoadedPack
  autoApprove?: boolean
  log?: (line: string) => void
  pollMs?: number
  /** Called whenever a question opens; the CLI uses it to print a notice. */
  onQuestion?: (q: Question) => void
}

/** One `until` loop the current step is inside. */
export interface UntilFrame {
  id: string
  round: number
  max: number
}

/**
 * Where a step runs. A branch is `main`, one story, or one task.
 * `prefix` is the step path (e.g. `build/story-loop[0]/design{2}/tdd{1}`).
 * `vars` holds `{story}`, `{task}`, `{round}`, `{workspace}`, `{run}`.
 */
export interface Ctx {
  prefix: string
  branch: string
  vars: Record<string, string>
  directory: string
  phase: Phase
  /** Enclosing `until` loops, outermost first. A failure goes to the last one; with none, the job fails. */
  untilStack: UntilFrame[]
}

/** What a step or sequence reports upward. `failed` travels up to the nearest `until` loop. */
export interface SeqResult {
  failed?: boolean
  failedStep?: string
  reason?: string
}

export const PASSED: SeqResult = {}

export function failedAt(step: string, reason: string): SeqResult {
  return { failed: true, failedStep: step, reason }
}

export function stepKey(ctx: Ctx, stepId: string): string {
  return `${ctx.prefix}/${stepId}`
}

export function touchBranch(s: JobState, id: string, patch: Partial<JobState["branches"][string]>): void {
  const b = (s.branches[id] ??= { id, status: "idle", since: new Date().toISOString() })
  if (patch.status && patch.status !== b.status) b.since = new Date().toISOString()
  Object.assign(b, patch)
}

export function phaseIndex(p: Phase): number {
  return ["intake", "discovery", "plan", "build", "close", "done"].indexOf(p)
}

export function valueToString(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (v && typeof v === "object" && "id" in v) return String((v as { id: unknown }).id)
  return JSON.stringify(v)
}

export function modelName(m: { providerID: string; id: string }): string {
  return `${m.providerID}/${m.id}`
}

/** Only story/task/round are logged per step; the rest stays in state.json. */
export function pickVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ["story", "task", "round"]) if (vars[k]) out[k] = vars[k]!
  return out
}
