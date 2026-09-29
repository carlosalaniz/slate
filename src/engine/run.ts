import { PHASES } from "../pack/schema.ts"
import type { JobState } from "./types.ts"
import { StopSignal, JobFailed } from "./types.ts"
import type { Engine } from "./engine.ts"
import { phaseIndex, type Ctx } from "./job.ts"
import { loadCorePack } from "./core-pack.ts"
import { jobContext, baseVars, loadPinnedPack } from "./prepare.ts"
import { runIntake } from "./intake.ts"
import { runSequence } from "./sequence.ts"
import { watchControl, stopJob } from "./control.ts"
import { checkContextOf, collectRequirements, mcpServers, preflight, projectEnv, waived, writeCatalog } from "./capabilities.ts"
import type { LoadedPack, Phase } from "./types.ts"

/**
 * run — the job lifecycle: intake once, then discovery, plan, build and close in order.
 * The job ends done, stopped (a human or a budget cap asked) or failed (work failed outside any
 * `until` loop). Stopped and failed jobs both resume with `slate continue`.
 */

export async function runJob(engine: Engine): Promise<JobState> {
  await engine.o.state.update((s) => {
    s.status = "running"
    s.stopReason = undefined
    prepareResume(s)
  })
  engine.o.audit.append({ type: "job", status: "running", phase: engine.state.phase })
  const control = watchControl(engine)
  try {
    engine.core = await loadCorePack()
    if (engine.state.phase === "intake") await runIntake(engine)
    if (!engine.pack) await loadPinnedPack(engine)
    const pack = engine.pack!
    const startedIn = engine.state.phase
    const req = await collectRequirements(checkContextOf(engine), pack, startedIn)
    engine.sharedTools = req.sharedTools
    engine.mcpNames = mcpServers(pack, req, waived(engine), projectEnv(engine.o.root)).map((s) => s.name)
    await engine.o.runtime.start(jobContext(engine, pack))
    await writeCatalog(engine.o.root, pack, engine.core)
    await requireCapabilities(engine, pack, req)
    for (const phase of PHASES) {
      if (phaseIndex(engine.state.phase) > phaseIndex(phase)) continue
      // A job that ran discovery itself learns what the product needs only now.
      if (phase === "plan" && phaseIndex(startedIn) < phaseIndex("plan")) await requireCapabilities(engine, pack, await collectRequirements(checkContextOf(engine), pack, "plan"))
      await engine.o.state.update((s) => {
        s.phase = phase
      })
      engine.o.audit.append({ type: "job", status: "phase", phase })
      engine.log(`== phase ${phase} ==`)
      const ctx: Ctx = { prefix: phase, branch: "main", vars: baseVars(engine), directory: engine.o.root, phase, untilStack: [] }
      const res = await runSequence(engine, pack.manifest.phases[phase], ctx)
      if (res.failed) throw new JobFailed(`${phase} failed at ${res.failedStep}: ${res.reason}`)
    }
    await engine.o.state.update((s) => {
      s.phase = "done"
      s.status = "done"
    })
    engine.o.audit.append({ type: "job", status: "done" })
    engine.log(`job ${engine.state.job.id} done`)
  } catch (e) {
    const [status, reason] = e instanceof StopSignal ? (["stopped", e.message] as const) : e instanceof JobFailed ? (["failed", e.message] as const) : (["failed", `engine error: ${(e as Error).message}`] as const)
    await engine.o.state.update((s) => {
      s.status = status
      s.stopReason = reason
    })
    engine.o.audit.append({ type: "job", status, reason: e instanceof StopSignal || e instanceof JobFailed ? reason : `engine error: ${(e as Error).stack ?? (e as Error).message}` })
    engine.log(`${status}: ${reason}`)
    if (!(e instanceof StopSignal) && !(e instanceof JobFailed)) throw e
  } finally {
    control.abort()
    // Unanswered questions die with the process; the steps that asked them ask again on resume.
    await engine.o.state.update((s) => dropOpenQuestions(s))
    await engine.o.audit.flush()
    await engine.o.state.flush()
    await engine.o.runtime.close()
  }
  return engine.state
}

/**
 * Registers the MCP servers the job needs, runs every requirement check (none spends tokens) and
 * halts the job, listing each fix, when something is missing and not waived. `slate continue`
 * checks again.
 */
async function requireCapabilities(engine: Engine, pack: LoadedPack, req: Awaited<ReturnType<typeof collectRequirements>>): Promise<void> {
  for (const t of req.sharedTools) engine.sharedTools.add(t)
  for (const [skill, need] of req.needSkills) engine.needSkills.set(skill, need)
  const servers = mcpServers(pack, req, waived(engine), projectEnv(engine.o.root))
  for (const s of servers) if (!engine.mcpNames.includes(s.name)) engine.mcpNames.push(s.name)
  await engine.o.runtime.ensureMcp(servers)
  const r = await preflight(checkContextOf(engine), pack, req)
  // Agents' shells get Slate's environment: the keys the job needs, from the project's .env when not exported.
  const env = projectEnv(engine.o.root)
  for (const k of [...req.env.keys(), ...[...req.tools.keys()].flatMap((t) => pack.capabilities[t]?.env ?? [])]) if (process.env[k] === undefined && env[k] !== undefined) process.env[k] = env[k]
  engine.o.audit.append({ type: "preflight", ok: r.ok, checked: r.checked, waived: r.waived, problems: r.problems })
  if (r.checked.length) engine.log(`requirements checked: ${r.checked.join(", ")}${r.waived.length ? `; waived: ${r.waived.join(", ")}` : ""}`)
  if (r.ok) return
  throw stopJob(engine, `missing requirements, so the job is halted before any work that needs them:\n${r.problems.map((p) => `  - ${p}`).join("\n")}\nFix them, then run slate continue (\`slate check\` re-runs the checks alone).`)
}

/**
 * `slate continue` is the retry for everything outside a loop, so resuming resets what a retry needs:
 *  - a step cut off mid-run is discarded and runs again (a partial step is never replayed)
 *  - failed steps and failed over-loop items run again; passed ones are skipped
 *  - an until loop that ran out of rounds gets `max` more
 *  - questions nobody answered are asked again by the step that raised them
 */
function prepareResume(s: JobState): void {
  const now = new Date().toISOString()
  for (const rec of Object.values(s.steps)) {
    if (rec.status === "running") {
      rec.status = "interrupted"
      rec.finished = now
    }
  }
  for (const cur of Object.values(s.loops)) {
    for (const it of cur.iterations ?? []) if (it.status === "running" || it.status === "failed") it.status = "interrupted"
    if (cur.kind === "until" && cur.exhausted && !cur.passed && !cur.skipped) {
      cur.exhausted = false
      cur.extra = (cur.round ?? 1) - 1
    }
  }
  dropOpenQuestions(s)
}

function dropOpenQuestions(s: JobState): void {
  s.questions = s.questions.filter((q) => q.answered)
  for (const b of Object.values(s.branches)) {
    if (b.status === "blocked" || b.status === "running") {
      b.status = "idle"
      b.blockedOn = undefined
    }
  }
}
