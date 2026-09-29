import type { CorePack, JobState, LoadedPack, Question } from "./types.ts"
import type { EngineOptions } from "./job.ts"
import { runJob } from "./run.ts"
import { answerQuestion } from "./inbox.ts"

export type { EngineOptions, Ctx, SeqResult } from "./job.ts"

/**
 * One job driven by one process. The durable state is state.json; this class only holds what the
 * process needs while it runs. The work lives in small files:
 *
 *   run.ts       job lifecycle: intake, the four phases, resume, stop/fail
 *   intake.ts    idea -> brief -> pack
 *   sequence.ts  steps in order; a failure goes up
 *   step.ts      skill, script and approval steps
 *   loops.ts     over (one branch per item) and until (rounds), and what happens when rounds run out
 *   prepare.ts   job context, scope, permissions, attached files, the step prompt
 *   inbox.ts     questions: open, wait, answer
 *   spend.ts     cost accounting and budget caps
 *   control.ts   stop requests, checkpoints, plan revisions
 */
export class Engine {
  stopRequested: false | "soft" | "hard" = false
  /** Why the stop was requested, when Slate requested it (e.g. a budget cap). */
  stopReason?: string
  /** Skill steps with a live session, by step key. */
  readonly running = new Map<string, { sessionID?: string; abort: AbortController; branch: string }>()
  pack?: LoadedPack
  core?: CorePack
  readonly log: (line: string) => void
  readonly pollMs: number
  readonly answersSeen = new Set<string>()
  /** MCP servers registered for this job (capabilities some session requires). */
  mcpNames: string[] = []
  /** Tools every worker may use: those of the skills and capabilities discovery's needs map. */
  sharedTools = new Set<string>()
  /** Skills discovery's needs map to (skill id -> need id): workers are told to use them. */
  needSkills = new Map<string, string>()

  constructor(public readonly o: EngineOptions) {
    this.pack = o.pack
    this.log = o.log ?? (() => undefined)
    this.pollMs = o.pollMs ?? 1000
  }

  get state(): JobState {
    return this.o.state.get()
  }

  /** Runs (or resumes) the job until it is done, stopped, or failed. */
  run(): Promise<JobState> {
    return runJob(this)
  }

  /** Soft: every branch finishes its current step, checkpoints and halts. Hard: in-flight sessions are interrupted. */
  requestStop(now: boolean, reason?: string): void {
    if (this.stopRequested !== "hard") this.stopRequested = now ? "hard" : "soft"
    this.stopReason ??= reason
    if (now) for (const r of this.running.values()) r.abort.abort()
  }

  stopNow(): boolean {
    return this.stopRequested === "hard"
  }

  answer(id: string, answer: string, message?: string, by: NonNullable<Question["answered"]>["by"] = "human"): Promise<boolean> {
    return answerQuestion(this, id, answer, message, by)
  }
}
