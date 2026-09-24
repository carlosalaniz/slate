import type { ExhaustedSimple, LoopStep } from "../pack/schema.ts"
import type { Engine } from "./engine.ts"
import { failedAt, stepKey, touchBranch, valueToString, PASSED, type Ctx, type SeqResult } from "./job.ts"
import type { LoopIteration } from "./types.ts"
import { runScript } from "./scripts.ts"
import { runSequence } from "./sequence.ts"
import { openQuestion, waitForAnswer } from "./inbox.ts"
import { checkPlanRevision, stopJob } from "./control.ts"
import { renderPrompt } from "./core-pack.ts"
import { tier } from "./prepare.ts"

/**
 * loops — the only place work is retried.
 *
 * `until` runs its steps in rounds until a verdict or script passes, or (`until: all-pass`) until a
 * round in which every step passed. A failure inside a round fails that round. When `max` rounds are used up, `on_exhausted` decides:
 *   ask-human / ask-decision-agent -> retry (max more rounds) | skip (the loop counts as done) | stop the job
 *   fail -> the loop fails, which fails the round of the enclosing until loop (or the job, if none)
 * Wrapping steps in an outer until loop is how a pack says "redo the design when the build keeps failing".
 *
 * `over` asks a script for the next item and runs the steps once per item, each item on its own
 * branch (and, for tasks in build, its own worktree). When an item fails, no new items start; the
 * running ones finish, and the loop reports the failure upward.
 */

export function runLoop(engine: Engine, step: LoopStep, ctx: Ctx): Promise<SeqResult> {
  return step.until ? runUntil(engine, step, ctx) : runOver(engine, step, ctx)
}

/* --------------------------------------------------------------------- until */

async function runUntil(engine: Engine, step: LoopStep, ctx: Ctx): Promise<SeqResult> {
  const key = stepKey(ctx, step.id)
  const until = step.until!
  const max = Number(step.max)
  const cursor = () => engine.state.loops[key]!
  if (!engine.state.loops[key]) await engine.o.state.update((s) => (s.loops[key] = { key, loop: step.id, kind: "until", round: 1 }))
  if (cursor().passed || cursor().skipped) return PASSED
  let round = cursor().round ?? 1
  let lastReason = ""
  while (true) {
    const limit = max + (cursor().extra ?? 0)
    if (round > limit) {
      await engine.o.state.update((s) => {
        s.loops[key]!.exhausted = true
        s.loops[key]!.round = round
      })
      const policy = (step.on_exhausted as ExhaustedSimple | undefined) ?? defaultPolicy(engine)
      engine.o.audit.append({ type: "loop.exhausted", key, loop: step.id, policy })
      engine.log(`  ${key}: out of rounds after ${limit}`)
      const decision = await onExhausted(engine, policy, { key, loop: step.id, rounds: limit, max, lastFailure: lastReason || "the condition never passed", ctx })
      if (decision === "fail") return failedAt(step.id, `out of rounds after ${limit} (${lastReason})`)
      if (decision === "skip") {
        await engine.o.state.update((s) => {
          s.loops[key]!.skipped = true
        })
        return PASSED
      }
      if (decision === "stop") throw stopJob(engine, `loop '${step.id}' ran out of rounds at ${key}. Run slate continue to give it ${max} more.`)
      await engine.o.state.update((s) => {
        s.loops[key]!.extra = (s.loops[key]!.extra ?? 0) + max
        s.loops[key]!.exhausted = false
      })
      continue
    }
    await engine.o.state.update((s) => {
      s.loops[key]!.round = round
    })
    engine.o.audit.append({ type: "loop.round", key, loop: step.id, round, max: limit })
    const inner: Ctx = {
      ...ctx,
      prefix: `${key}{${round}}`,
      vars: { ...ctx.vars, round: String(round), [`round.${step.id}`]: String(round) },
      untilStack: [...ctx.untilStack, { id: step.id, round, max: limit }],
    }
    const res = await runSequence(engine, step.steps, inner)
    let passed = false
    if (res.failed) {
      lastReason = `${res.failedStep}: ${res.reason}`
    } else if (until === "all-pass") {
      passed = true
    } else if ("result" in until) {
      const verdict = engine.state.steps[`${inner.prefix}/${until.result}`]?.verdict
      passed = verdict === "pass"
      if (!passed) lastReason = `${until.result} verdict: ${verdict ?? "missing"}`
    } else {
      const spec = engine.pack!.scripts[until.script]!
      const r = await runScript({ script: spec, packDir: engine.pack!.dir, workspace: ctx.directory, args: until.args, vars: inner.vars, run: engine.state.job.id })
      engine.o.audit.append({ type: "script", key: inner.prefix, script: spec.id, ok: r.ok, output: r.stdout.slice(0, 500), error: r.error })
      if (!r.ok) throw stopJob(engine, `until-script '${spec.id}' is broken (${r.error}). Fix it, then run slate continue.`)
      passed = r.json?.pass === true
      if (!passed) lastReason = String(r.json?.reason ?? "check did not pass")
    }
    if (passed) {
      await engine.o.state.update((s) => {
        s.loops[key]!.passed = true
      })
      return PASSED
    }
    round++
  }
}

function defaultPolicy(engine: Engine): ExhaustedSimple {
  const cfg = engine.state.config["on_exhausted"]
  return cfg === "fail" || cfg === "ask-decision-agent" ? cfg : "ask-human"
}

type Decision = "retry" | "skip" | "stop" | "fail"

async function onExhausted(engine: Engine, policy: ExhaustedSimple, info: { key: string; loop: string; rounds: number; max: number; lastFailure: string; ctx: Ctx }): Promise<Decision> {
  if (policy === "fail") return "fail"
  const context = recentOutputs(engine, info.key)
  const question = {
    kind: "exhausted" as const,
    prompt: `Loop '${info.loop}' used all ${info.rounds} rounds. Last failure: ${info.lastFailure}. Retry with ${info.max} more rounds, skip it, or stop the job?`,
    context,
    options: [
      { id: "retry", label: `retry (${info.max} more rounds)`, default: true },
      { id: "skip", label: "skip this loop and go on" },
      { id: "stop", label: "stop the job (slate continue retries later)" },
    ],
    branch: info.ctx.branch,
    stepKey: info.key,
    step: info.loop,
    story: info.ctx.vars.story,
  }
  if (policy === "ask-decision-agent") {
    try {
      const core = engine.core!
      const decider = core.agents["slate-decision"]!
      const text = await engine.o.runtime.review({
        reviewer: decider,
        model: tier(engine, decider.model),
        prompt: renderPrompt(core, "decision", { loop: info.loop, max: info.rounds, last_failure: info.lastFailure, context: context.join("\n") }),
        inputs: [],
      })
      const d = /^(retry|skip|stop)\b/im.exec(text.trim())?.[1]?.toLowerCase() ?? "stop"
      const q = await openQuestion(engine, { ...question, autoAnswer: d, autoBy: "decision-agent", autoMessage: text.slice(0, 300) })
      return (await waitForAnswer(engine, q.id)) as Decision
    } catch (e) {
      engine.log(`decision agent failed (${(e as Error).message}); asking a human`)
    }
  }
  const q = await openQuestion(engine, question)
  return (await waitForAnswer(engine, q.id)) as Decision
}

/** The last few skill results inside a loop, shown with its exhausted question. */
function recentOutputs(engine: Engine, loopKey: string): string[] {
  return Object.values(engine.state.steps)
    .filter((r) => r.key.startsWith(`${loopKey}{`) && r.type === "skill")
    .slice(-3)
    .map((r) => {
      const last = r.attempts[r.attempts.length - 1]
      return `${r.key}: ${r.status}${r.verdict ? ` verdict=${r.verdict}` : ""}${last?.failure ? ` (${last.failure})` : ""}`
    })
}

/* ---------------------------------------------------------------------- over */

async function runOver(engine: Engine, step: LoopStep, ctx: Ctx): Promise<SeqResult> {
  const key = stepKey(ctx, step.id)
  const max = Number(step.max)
  const concurrency = Math.max(1, Number(step.concurrency ?? 1))
  const as = step.as!
  const spec = engine.pack!.scripts[step.over!.script]!
  if (!engine.state.loops[key]) await engine.o.state.update((s) => (s.loops[key] = { key, loop: step.id, kind: "over", iterations: [] }))
  const wantsWorktree = step.worktree ?? (ctx.phase === "build" && as === "task" && engine.o.project.runtime.worktrees !== "none")

  const active = new Map<number, Promise<void>>()
  /** Something was thrown (a stop, a job failure, an engine bug): end the loop and rethrow once running items settle. */
  let thrown: Error | undefined
  /** An item failed: start no new items and report the failure upward. */
  let failure: SeqResult | undefined

  const runIteration = async (it: LoopIteration) => {
    let directory = ctx.directory
    if (wantsWorktree) {
      directory = (await engine.o.runtime.worktree.create({ name: it.value.replace(/[^a-zA-Z0-9_.-]/g, "-"), sourceDirectory: ctx.directory })).directory
      engine.o.audit.append({ type: "worktree", key: `${key}[${it.n}]`, action: "create", directory })
    }
    // untilStack is kept: an item's failure is a failed round of the loop around this one.
    const inner: Ctx = { ...ctx, prefix: `${key}[${it.n}]`, branch: it.branch, directory, vars: { ...ctx.vars, [as]: it.value, [`${as}_dir`]: directory } }
    await engine.o.state.update((s) => touchBranch(s, it.branch, { status: "idle", story: inner.vars.story }))
    // Anything thrown leaves the item interrupted, so a resume re-runs it in place.
    let status: "done" | "failed" | "interrupted" = "interrupted"
    try {
      const res = await runSequence(engine, step.steps, inner)
      status = res.failed ? "failed" : "done"
      if (res.failed) failure ??= failedAt(`${as} ${it.value}`, `${res.failedStep}: ${res.reason}`)
    } finally {
      await engine.o.state.update((s) => {
        const rec = s.loops[key]!.iterations!.find((x) => x.n === it.n)
        if (rec) rec.status = status
        touchBranch(s, it.branch, { status: status === "interrupted" ? "idle" : status, current: undefined })
      })
    }
  }
  const start = (it: LoopIteration) => {
    const pr = runIteration(it)
      .catch((e: Error) => {
        thrown ??= e
      })
      .finally(() => active.delete(it.n))
    active.set(it.n, pr)
    return pr
  }
  const setDone = () =>
    engine.o.state.update((s) => {
      s.loops[key]!.overDone = true
    })

  while (!thrown && !failure) {
    const cur = engine.state.loops[key]!
    const iterations = cur.iterations!
    // Resume: items cut short by a stop or crash re-run in place; steps that already passed are skipped.
    for (const p of iterations.filter((x) => x.status === "interrupted" && !active.has(x.n))) {
      if (active.size >= concurrency) break
      await engine.o.state.update((s) => {
        const r = s.loops[key]!.iterations!.find((x) => x.n === p.n)
        if (r) r.status = "running"
      })
      start(p)
    }
    if (cur.overDone) {
      if (active.size === 0) break
      await Promise.race(active.values())
      continue
    }
    if (iterations.length >= max) {
      await setDone()
      engine.log(`  ${key}: reached max ${max} items`)
      continue
    }
    if (active.size >= concurrency) {
      await Promise.race(active.values())
      continue
    }
    try {
      await checkPlanRevision(engine, ctx)
    } catch (e) {
      thrown = e as Error
      break
    }
    const claimed = iterations.map((x) => x.value)
    const running = iterations.filter((x) => x.status === "running").map((x) => x.value)
    const r = await runScript({
      script: spec,
      packDir: engine.pack!.dir,
      workspace: ctx.directory,
      args: step.over!.args,
      vars: ctx.vars,
      run: engine.state.job.id,
      extraEnv: { SLATE_CLAIMED: JSON.stringify(claimed), SLATE_RUNNING: JSON.stringify(running) },
    })
    engine.o.audit.append({ type: "script", key, script: spec.id, ok: r.ok, output: r.stdout.slice(0, 500), error: r.error })
    if (!r.ok) {
      thrown = stopJob(engine, `loop script '${spec.id}' is broken (${r.error}). Fix it, then run slate continue.`)
      break
    }
    if (r.json?.done === true || r.json?.next === undefined || r.json?.next === null) {
      // Nothing ready now; running items may unblock more (e.g. a dependency gets merged).
      if (active.size > 0 && r.json?.done !== true) await Promise.race(active.values())
      else await setDone()
      continue
    }
    const value = valueToString(r.json.next)
    if (claimed.includes(value)) {
      if (active.size > 0) {
        await Promise.race(active.values())
        continue
      }
      engine.log(`  ${key}: script returned '${value}' which is already ${running.includes(value) ? "running" : "claimed"}; treating the loop as done`)
      await setDone()
      continue
    }
    const it: LoopIteration = { n: iterations.length, value, status: "running", branch: ctx.branch === "main" ? `${as}:${value}` : `${ctx.branch}/${as}:${value}` }
    await engine.o.state.update((s) => s.loops[key]!.iterations!.push(it))
    engine.o.audit.append({ type: "loop.iteration", key, loop: step.id, iteration: it.n, value })
    engine.log(`  ${key}: ${as}=${value} (#${it.n + 1})`)
    const pr = start({ ...it })
    if (concurrency === 1) await pr
  }
  await Promise.allSettled(active.values())
  if (thrown) throw thrown
  return failure ?? PASSED
}
