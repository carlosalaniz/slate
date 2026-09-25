import type { AgentSpec } from "../pack/schema.ts"
import { usd } from "../util/time.ts"
import type { Engine } from "./engine.ts"
import { modelName } from "./job.ts"
import type { RunStepResult } from "./types.ts"

/**
 * spend — money and tokens. Every session's cost is recorded by model, agent, step, task and story.
 * A budget cap is never a question: when one is reached the job stops at the next step boundary.
 * Raise the cap in slate.config.yml, then `slate continue`.
 */

export async function recordSpend(engine: Engine, result: RunStepResult, agent: AgentSpec, vars: Record<string, string>, stepId: string): Promise<void> {
  const cost = result.cost || 0
  const model = modelName(result.model)
  await engine.o.state.update((s) => {
    const sp = s.spend
    sp.total += cost
    sp.byModel[model] = (sp.byModel[model] ?? 0) + cost
    sp.byAgent[agent.id] = (sp.byAgent[agent.id] ?? 0) + cost
    sp.byStep[stepId] = (sp.byStep[stepId] ?? 0) + cost
    if (vars.task) sp.byTask[vars.task] = (sp.byTask[vars.task] ?? 0) + cost
    if (vars.story) sp.byStory[vars.story] = (sp.byStory[vars.story] ?? 0) + cost
    sp.tokens.input += result.tokens.input
    sp.tokens.output += result.tokens.output
    sp.tokens.reasoning += result.tokens.reasoning
    sp.tokens.cache.read += result.tokens.cache.read
    sp.tokens.cache.write += result.tokens.cache.write
  })
}

export interface BudgetHit {
  scope: string
  spent: number
  cap: number
  /** What the human reads in `slate status`: which cap, and how to go on. */
  message: string
}

/** The first cap a step with these vars would run past, or undefined when within budget. */
export function budgetHit(engine: Engine, vars: Record<string, string>): BudgetHit | undefined {
  const b = engine.o.project.budget
  const sp = engine.state.spend
  const hit = (scope: string, spent: number, cap: number, key: string): BudgetHit => ({
    scope,
    spent,
    cap,
    message: `budget reached for ${scope}: ${usd(spent)} of ${usd(cap)}. Raise ${key} in slate.config.yml, then run slate continue.`,
  })
  if (b.job && sp.total >= b.job) return hit("the job", sp.total, b.job, "budget.job")
  const task = vars.task
  if (task && b.per_task && (sp.byTask[task] ?? 0) >= b.per_task) return hit(`task ${task}`, sp.byTask[task]!, b.per_task, "budget.per_task")
  for (const [model, cap] of Object.entries(b.per_model)) {
    // Caps may name `provider/model` or just `model`.
    const spent = Object.entries(sp.byModel)
      .filter(([m]) => m === model || m.endsWith(`/${model}`))
      .reduce((sum, [, c]) => sum + c, 0)
    if (cap > 0 && spent >= cap) return hit(`model ${model}`, spent, cap, `budget.per_model.${model}`)
  }
  return undefined
}
