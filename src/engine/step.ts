import path from "node:path"
import type { AgentSpec, ApprovalStep, ScriptStep, SkillSpec, SkillStep } from "../pack/schema.ts"
import { nowIso, sleep } from "../util/time.ts"
import { readTextOr } from "../util/fs.ts"
import type { Engine } from "./engine.ts"
import { failedAt, modelName, pickVars, stepKey, touchBranch, PASSED, type Ctx, type SeqResult } from "./job.ts"
import { StopSignal, JobFailed, EMPTY_TOKENS, type Attempt, type RunStepResult, type StepStatus } from "./types.ts"
import { checkContracts, repromptText } from "./contracts.ts"
import { runScript } from "./scripts.ts"
import { resolveRuntime } from "./vars.ts"
import { composePrompt, permissionRules, resolveAgentAndSkill, resolveReads, resolveScope, tier } from "./prepare.ts"
import { openQuestion, relayRuntimeQuestion, syncJobStatus, waitForAnswer } from "./inbox.ts"
import { recordSpend } from "./spend.ts"
import { appendRevisionNote, stopJob } from "./control.ts"

/**
 * step — the three leaf steps: skill (an agent session), script (a check that reads files),
 * approval (a human decision). Each returns PASSED or a failure that travels up to the nearest
 * `until` loop. Broken infrastructure (a crashing script, a provider that keeps failing) is not a
 * failed round: it stops the job so a human can fix it and `slate continue`.
 */

export async function runSkillStep(engine: Engine, step: SkillStep, ctx: Ctx): Promise<SeqResult> {
  const { agent, skill } = resolveAgentAndSkill(engine, step)
  if (!agent || !skill) throw new JobFailed(`${stepKey(ctx, step.id)}: unknown agent '${step.by}' or skill '${step.skill}'`)
  return runSkill(engine, step, ctx, agent, skill)
}

/** One agent session, judged only by the files it leaves behind. A missed contract gets one re-prompt in the same session. */
export async function runSkill(engine: Engine, step: SkillStep, ctx: Ctx, agent: AgentSpec, skill: SkillSpec): Promise<SeqResult> {
  const key = stepKey(ctx, step.id)
  const vars: Record<string, string> = { ...ctx.vars, step: step.id }
  const model = tier(engine, step.model ?? agent.model)
  const rt = engine.o.project.runtime
  await engine.o.state.update((s) => {
    s.steps[key] = { key, step: step.id, type: "skill", branch: ctx.branch, vars, status: "running", attempts: [], started: nowIso(), directory: ctx.directory }
    touchBranch(s, ctx.branch, { status: "running", current: step.id })
    syncJobStatus(s)
  })
  engine.o.audit.append({ type: "step.start", key, step: step.id, branch: ctx.branch, agent: agent.id, vars: pickVars(vars) })
  engine.log(`> ${key} (${agent.id}, ${modelName(model)})`)

  const scope = await resolveScope(engine, step, agent, ctx)
  const permissions = permissionRules(agent, scope, step, step.writes.map((w) => resolveRuntime(w, vars)))
  const files = await resolveReads(skill.reads, ctx.directory, vars)
  const prompt = composePrompt(engine, step, ctx, skill, scope, vars, agent)
  const abort = new AbortController()
  engine.running.set(key, { abort, branch: ctx.branch })

  let attemptNo = 0
  let infraTries = 0
  let reprompts = 0
  try {
    while (true) {
      if (engine.stopRequested) throw new StopSignal(engine.stopNow(), engine.stopReason)
      attemptNo++
      const started = nowIso()
      let result: RunStepResult
      try {
        result = await engine.o.runtime.runStep({
          key,
          stepId: step.id,
          agent,
          skill,
          model,
          directory: ctx.directory,
          prompt,
          files,
          permissions,
          consult: step.consult,
          gates: step.gates ?? [],
          vars,
          title: `${engine.state.job.name}: ${key}`,
          timeoutMs: rt.step_timeout_minutes * 60_000,
          contract: { writes: step.writes, result: step.result },
          phase: ctx.phase,
          onQuestion: (rq) => void relayRuntimeQuestion(engine, rq, ctx, step, key),
          onAudit: (e) => engine.o.audit.append(e),
          signal: abort.signal,
        })
      } catch (e) {
        result = { sessionID: "", outcome: "failed", cost: 0, tokens: { ...EMPTY_TOKENS, cache: { read: 0, write: 0 } }, model, error: { type: "runtime", message: (e as Error).message }, consults: 0 }
      }
      engine.running.set(key, { sessionID: result.sessionID, abort, branch: ctx.branch })
      await recordSpend(engine, result, agent, vars, step.id)
      const attempt: Attempt = { n: attemptNo, started, finished: nowIso(), sessionID: result.sessionID, outcome: result.outcome, cost: result.cost, model: modelName(result.model) }

      if (result.outcome === "interrupted" || (engine.stopNow() && result.outcome !== "succeeded")) {
        await finishStep(engine, key, "interrupted", { ...attempt, failure: "interrupted" })
        throw new StopSignal(true, engine.stopReason ?? `interrupted while running ${key}`)
      }
      if (result.outcome === "timeout") {
        await finishStep(engine, key, "failed", { ...attempt, failure: "step timed out", failureClass: "timeout" })
        engine.log(`  ${key}: timed out`)
        return failedAt(step.id, `timed out after ${rt.step_timeout_minutes} minutes`)
      }
      if (result.outcome === "failed") {
        // Provider or runtime trouble. OpenCode's retry hook tried first; here the whole step is retried a few times.
        // It never counts as a round. If it keeps failing, the job stops.
        infraTries++
        const msg = `${result.error?.type ?? "error"}: ${result.error?.message ?? ""}`.slice(0, 300)
        engine.o.audit.append({ type: "infra.retry", key, step: step.id, attempt: infraTries, error: msg })
        if (infraTries <= rt.infra_retries) {
          await engine.o.state.update((s) => s.steps[key]?.attempts.push({ ...attempt, failure: msg, failureClass: "infra" }))
          engine.log(`  ${key}: infrastructure failure (${msg}); retry ${infraTries}/${rt.infra_retries}`)
          await sleep(Math.min(30_000, 2000 * 2 ** infraTries), abort.signal)
          continue
        }
        await finishStep(engine, key, "failed", { ...attempt, failure: msg, failureClass: "infra" })
        throw stopJob(engine, `${key} kept failing on infrastructure (${msg}). Fix the provider or runtime, then run slate continue.`)
      }

      // The session finished. Now the only judge is the filesystem.
      const contract = { directory: ctx.directory, writes: step.writes, result: step.result, vars }
      let check = await checkContracts(contract)
      if (!check.ok && reprompts < rt.contract_reprompts && result.sessionID) {
        reprompts++
        engine.o.audit.append({ type: "contract.failed", key, step: step.id, missing: check.missing, reason: check.reason ?? "", reprompt: true })
        await engine.o.state.update((s) => s.contractFailures.push({ key, step: step.id, missing: check.missing, at: nowIso(), retried: true }))
        engine.log(`  ${key}: contract not met (${check.reason}); re-prompting once`)
        const again = await engine.o.runtime.reprompt({ sessionID: result.sessionID, text: repromptText(engine.core!, check, step.writes, step.result, vars), timeoutMs: rt.step_timeout_minutes * 60_000 })
        await recordSpend(engine, { ...again, cost: Math.max(0, again.cost - result.cost) }, agent, vars, step.id)
        check = await checkContracts(contract)
      }
      if (!check.ok) {
        engine.o.audit.append({ type: "contract.failed", key, step: step.id, missing: check.missing, reason: check.reason ?? "", reprompt: false })
        await engine.o.state.update((s) => s.contractFailures.push({ key, step: step.id, missing: check.missing, at: nowIso(), retried: false }))
        await finishStep(engine, key, "failed", { ...attempt, failure: check.reason, failureClass: "contract" })
        engine.log(`  ${key}: FAILED contract: ${check.reason}`)
        return failedAt(step.id, `output contract not met: ${check.reason}`)
      }
      if (check.verdict) {
        engine.o.audit.append({ type: "verdict", key, step: step.id, file: check.resultFile ?? "", verdict: check.verdict })
        engine.log(`  ${key}: verdict ${check.verdict}`)
      }
      await finishStep(engine, key, "passed", attempt, check.verdict)
      return PASSED
    }
  } finally {
    engine.running.delete(key)
    await engine.o.state.update((s) => {
      if (s.branches[ctx.branch]?.status === "running") touchBranch(s, ctx.branch, { status: "idle" })
      syncJobStatus(s)
    })
  }
}

/** Exit 0 with `{ ok: false }` is a failed check. Any other exit is a broken script, which stops the job. */
export async function runScriptStep(engine: Engine, step: ScriptStep, ctx: Ctx): Promise<SeqResult> {
  const key = stepKey(ctx, step.id)
  const spec = engine.pack!.scripts[step.script]!
  const vars: Record<string, string> = { ...ctx.vars, step: step.id }
  const started = nowIso()
  await engine.o.state.update((s) => {
    s.steps[key] = { key, step: step.id, type: "script", branch: ctx.branch, vars, status: "running", attempts: [], started, directory: ctx.directory }
  })
  engine.o.audit.append({ type: "step.start", key, step: step.id, branch: ctx.branch })
  engine.log(`> ${key} (script ${step.script})`)
  const r = await runScript({ script: spec, packDir: engine.pack!.dir, workspace: ctx.directory, args: step.args, vars, run: engine.state.job.id })
  engine.o.audit.append({ type: "script", key, script: step.script, ok: r.ok, output: r.stdout.slice(0, 1000), error: r.error })
  const attempt: Attempt = { n: 1, started, finished: nowIso() }
  if (!r.ok) {
    await finishStep(engine, key, "failed", { ...attempt, failure: `broken: ${r.error}`, failureClass: "script" })
    throw stopJob(engine, `script '${step.script}' is broken (${r.error}). Fix it, then run slate continue.`)
  }
  if (r.json?.ok === false) {
    const reason = String(r.json?.reason ?? "script reported ok: false")
    await finishStep(engine, key, "failed", { ...attempt, failure: reason, failureClass: "script" })
    engine.log(`  ${key}: check failed: ${reason}`)
    return failedAt(step.id, reason)
  }
  await finishStep(engine, key, "passed", attempt)
  return PASSED
}

/** Approve continues. Reject saves the note; inside an until loop it fails the round, outside it stops the job. */
export async function runApproval(engine: Engine, step: ApprovalStep, ctx: Ctx): Promise<SeqResult> {
  const key = stepKey(ctx, step.id)
  const vars: Record<string, string> = { ...ctx.vars, step: step.id }
  await engine.o.state.update((s) => {
    s.steps[key] = { key, step: step.id, type: "approval", branch: ctx.branch, vars, status: "running", attempts: [], started: nowIso() }
  })
  engine.o.audit.append({ type: "step.start", key, step: step.id, branch: ctx.branch })
  const context: string[] = []
  for (const show of step.show) {
    const rel = resolveRuntime(show, vars)
    context.push(`--- ${rel} ---\n${(await readTextOr(path.resolve(ctx.directory, rel), "(missing)")).slice(0, 4000)}`)
  }
  const q = await openQuestion(engine, {
    kind: "approval",
    prompt: resolveRuntime(step.prompt, vars),
    context,
    options: [{ id: "approve", label: "approve", default: true }, { id: "reject", label: "reject (add a note)" }],
    branch: ctx.branch,
    stepKey: key,
    step: step.id,
    story: vars.story,
    autoAnswer: engine.o.autoApprove ? "approve" : undefined,
    freeText: true,
  })
  const answer = await waitForAnswer(engine, q.id)
  const attempt: Attempt = { n: 1, started: q.created, finished: nowIso() }
  if (answer === "approve") {
    await finishStep(engine, key, "passed", attempt)
    return PASSED
  }
  const note = engine.state.questions.find((x) => x.id === q.id)?.answered?.message ?? ""
  await finishStep(engine, key, "failed", { ...attempt, failure: `rejected: ${note}`, failureClass: "rejected" })
  if (note) await appendRevisionNote(engine, `Rejected at ${step.id}: ${note}`)
  if (ctx.untilStack.length) return failedAt(step.id, `rejected: ${note}`)
  throw stopJob(engine, `'${step.id}' was rejected${note ? `: ${note}` : ""}. Your note is in .slate/plan-revisions.md; run slate continue to be asked again.`)
}

export async function finishStep(engine: Engine, key: string, status: StepStatus, attempt: Attempt | undefined, verdict?: string): Promise<void> {
  const rec = await engine.o.state.update((s) => {
    const r = s.steps[key]
    if (!r) return undefined
    r.status = status
    r.finished = nowIso()
    if (attempt) r.attempts.push(attempt)
    if (verdict) r.verdict = verdict
    return r
  })
  if (rec) engine.o.audit.append({ type: "step.end", key, step: rec.step, branch: rec.branch, status, sessionID: attempt?.sessionID, cost: attempt?.cost, reason: attempt?.failure })
}
