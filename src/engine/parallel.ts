import type { ParallelStep, Step } from "../pack/schema.ts"
import type { Engine } from "./engine.ts"
import { PASSED, type Ctx, type SeqResult } from "./job.ts"
import { checkpointGate } from "./control.ts"

/**
 * parallel — steps that run side by side, each a lane (the reference pack builds stories in one lane
 * while another reviews the screens of every story that lands).
 *
 * Lanes can feed each other: a review files a fix story, which the story loop then builds. So an
 * `over` loop that is a lane does not end when its script has nothing for it; it ends when the whole
 * group is quiet: every lane either finished or is idle and found nothing, with no work started or
 * finished anywhere since it looked. Until then it waits for the next change and asks again. Inside
 * a lane, `done` from the loop's script therefore means "nothing now".
 */

export class LaneGroup {
  /** Bumped whenever work starts or finishes in any lane. */
  version = 0
  private readonly settledAt = new Map<string, number>()
  private readonly finished = new Set<string>()
  private readonly failedLanes = new Set<string>()
  /** Each returns true once it has resolved. */
  private waiters: (() => boolean)[] = []

  constructor(private readonly lanes: string[]) {}

  bump(): void {
    this.version++
    this.wake()
  }

  /** The lane asked at `version` and had nothing to do. */
  settle(lane: string, version: number): void {
    this.settledAt.set(lane, version)
    this.wake()
  }

  finish(lane: string, failed: boolean): void {
    this.finished.add(lane)
    if (failed) this.failedLanes.add(lane)
    this.wake()
  }

  /** A lane failed or was stopped: the others end without marking themselves done, so a resume picks them up. */
  failed(): boolean {
    return this.failedLanes.size > 0
  }

  /** Every lane is finished, or idle and has looked since the last change. */
  quiet(): boolean {
    return this.lanes.every((l) => this.finished.has(l) || this.settledAt.get(l) === this.version)
  }

  /** Resolves once something changed after `since`, or the group went quiet. */
  changed(since: number): Promise<void> {
    if (this.version !== since || this.quiet()) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.push(() => {
        if (this.version === since && !this.quiet()) return false
        resolve()
        return true
      })
    })
  }

  private wake(): void {
    this.waiters = this.waiters.filter((w) => !w())
  }
}

export async function runParallel(engine: Engine, step: ParallelStep, ctx: Ctx, runStep: (engine: Engine, step: Step, ctx: Ctx) => Promise<SeqResult>): Promise<SeqResult> {
  await checkpointGate(engine, ctx)
  const group = new LaneGroup(step.steps.map((s) => s.id))
  const results = await Promise.allSettled(
    step.steps.map(async (child) => {
      let failed = true
      try {
        if (engine.state.steps[`${ctx.prefix}/${child.id}`]?.status === "passed") {
          failed = false
          return PASSED
        }
        const res = await runStep(engine, child, { ...ctx, lane: { group, id: child.id } })
        failed = Boolean(res.failed)
        return res
      } finally {
        group.finish(child.id, failed)
      }
    }),
  )
  const thrown = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
  if (thrown) throw thrown.reason
  return results.map((r) => (r as PromiseFulfilledResult<SeqResult>).value).find((r) => r.failed) ?? PASSED
}
