import path from "node:path"
import type { SkillStep, Step } from "../pack/schema.ts"
import { isFile, removePath, readJsonOr, readTextOr, writeText, ensureDir } from "../util/fs.ts"
import { nowIso, sleep } from "../util/time.ts"
import type { Engine } from "./engine.ts"
import type { Ctx } from "./job.ts"
import { StopSignal } from "./types.ts"
import { pollAnswers } from "./inbox.ts"
import { budgetHit } from "./spend.ts"
import { renderPrompt } from "./core-pack.ts"
import { runSkill } from "./step.ts"

/**
 * control — the checkpoint before every step, and the ways a human steers a running job from
 * another terminal: `slate stop [--now]` and `slate plan revise`, both as files in `.slate/control/`.
 */

/** Stops the whole job: this branch now, every other branch after its current step. Use as `throw stopJob(...)`. */
export function stopJob(engine: Engine, reason: string): StopSignal {
  engine.requestStop(false, reason)
  return new StopSignal(false, reason)
}

/** Before any step starts: honor stop requests and budget caps, and pick up answers written by `slate inbox`. */
export async function checkpointGate(engine: Engine, ctx: Ctx): Promise<void> {
  if (engine.stopRequested) throw new StopSignal(engine.stopNow(), engine.stopReason)
  const hit = budgetHit(engine, ctx.vars)
  if (hit) {
    engine.o.audit.append({ type: "budget", scope: hit.scope, spent: hit.spent, cap: hit.cap })
    throw stopJob(engine, hit.message)
  }
  await pollAnswers(engine)
}

/** Watches `.slate/control/stop` and `stop-now`, written by `slate stop` in another process. */
export function watchControl(engine: Engine): AbortController {
  const ac = new AbortController()
  const loop = async () => {
    const dir = engine.o.paths.control
    while (!ac.signal.aborted) {
      if (await isFile(path.join(dir, "stop-now"))) {
        await removePath(path.join(dir, "stop-now"))
        engine.requestStop(true, "stopped by slate stop --now")
      } else if (await isFile(path.join(dir, "stop"))) {
        await removePath(path.join(dir, "stop"))
        engine.requestStop(false, "stopped by slate stop")
      }
      await sleep(engine.pollMs, ac.signal)
    }
  }
  void loop()
  return ac
}

export async function appendRevisionNote(engine: Engine, note: string): Promise<void> {
  await ensureDir(path.dirname(engine.o.paths.planRevisions))
  const prev = await readTextOr(engine.o.paths.planRevisions, "# Plan revisions\n")
  await writeText(engine.o.paths.planRevisions, `${prev}\n- ${nowIso()}: ${note}\n`)
}

/** `slate plan revise` drops .slate/control/revise.json; at the next story boundary the plan's skill steps re-run with the note. */
export async function checkPlanRevision(engine: Engine, ctx: Ctx): Promise<void> {
  if (ctx.phase !== "build") return
  const file = path.join(engine.o.paths.control, "revise.json")
  if (!(await isFile(file))) return
  const data = await readJsonOr<{ note?: string }>(file, {})
  await removePath(file)
  const note = data.note ?? "(no note)"
  const n = await engine.o.state.update((s) => ++s.planRevisions)
  engine.o.audit.append({ type: "plan.revise", note })
  engine.log(`plan revision #${n}: ${note}`)
  await appendRevisionNote(engine, note)
  const revision = renderPrompt(engine.core!, "plan-revision", { revision: n, note })
  const inner: Ctx = { ...ctx, prefix: `plan~r${n}`, branch: "main", directory: engine.o.root, untilStack: [], phase: "plan", vars: { ...ctx.vars } }
  for (const s of skillSteps(engine.pack!.manifest.phases.plan)) {
    const step: SkillStep = { ...s, prompt: [s.prompt, revision].filter(Boolean).join("\n\n") }
    const res = await runSkill(engine, step, inner, engine.pack!.agents[step.by]!, engine.pack!.skills[step.skill]!)
    if (res.failed) engine.log(`plan revision step ${step.id} failed its contract; continuing with the previous plan`)
  }
}

/** Skill steps in order, including those inside loops (the plan phase may wrap them in a loop). */
function skillSteps(steps: Step[]): SkillStep[] {
  return steps.flatMap((s) => (s.type === "skill" ? [s] : s.type === "loop" ? skillSteps(s.steps) : []))
}
