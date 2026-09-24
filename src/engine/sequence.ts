import type { Step } from "../pack/schema.ts"
import type { Engine } from "./engine.ts"
import { stepKey, PASSED, type Ctx, type SeqResult } from "./job.ts"
import { checkpointGate } from "./control.ts"
import { runApproval, runScriptStep, runSkillStep } from "./step.ts"
import { runLoop } from "./loops.ts"

/**
 * sequence — steps in order. A step that already passed is skipped (that is how resume works).
 * The first failure ends the sequence and goes up to the caller: the enclosing until loop counts it
 * as a failed round; with no until loop around it, the job fails.
 */

export async function runSequence(engine: Engine, steps: Step[], ctx: Ctx): Promise<SeqResult> {
  for (const step of steps) {
    await checkpointGate(engine, ctx)
    if (engine.state.steps[stepKey(ctx, step.id)]?.status === "passed") continue
    const res = await runStep(engine, step, ctx)
    if (res.failed) return res
  }
  return PASSED
}

function runStep(engine: Engine, step: Step, ctx: Ctx): Promise<SeqResult> {
  switch (step.type) {
    case "skill":
      return runSkillStep(engine, step, ctx)
    case "script":
      return runScriptStep(engine, step, ctx)
    case "approval":
      return runApproval(engine, step, ctx)
    case "loop":
      return runLoop(engine, step, ctx)
  }
}
