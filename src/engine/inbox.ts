import path from "node:path"
import type { SkillStep } from "../pack/schema.ts"
import { nowIso, sleep, formatDuration } from "../util/time.ts"
import { shortId } from "../util/id.ts"
import { listDir, readJsonOr, removePath } from "../util/fs.ts"
import type { Engine } from "./engine.ts"
import { touchBranch, type Ctx } from "./job.ts"
import { StopSignal, JobFailed, type JobState, type Question, type QuestionKind, type QuestionOption, type RuntimeQuestion } from "./types.ts"

/**
 * inbox — questions for a human. A question pauses the branch that asked it; every other branch
 * keeps running. The job shows as `blocked` only when a question is open and nothing else is running.
 * Answers arrive in-process (`engine.answer`) or as files in `.slate/answers/` written by `slate inbox`.
 */

export interface OpenQuestionInput {
  kind: QuestionKind
  prompt: string
  context: string[]
  options: QuestionOption[]
  branch: string
  stepKey?: string
  step?: string
  story?: string
  sessionID?: string
  requestID?: string
  reviewerNotes?: string[]
  /** Answer given without asking when auto-approve is on, or always when `autoBy` is set. */
  autoAnswer?: string
  autoBy?: "human" | "decision-agent" | "timeout"
  autoMessage?: string
  freeText?: boolean
}

export async function openQuestion(engine: Engine, input: OpenQuestionInput): Promise<Question> {
  const { autoAnswer, autoBy, autoMessage, ...fields } = input
  const q: Question = { id: shortId("q"), ...fields, created: nowIso() }
  await engine.o.state.update((s) => {
    s.questions.push(q)
    touchBranch(s, q.branch, { status: "blocked", blockedOn: q.id })
    syncJobStatus(s)
  })
  engine.o.audit.append({ type: "question.open", id: q.id, kind: q.kind, branch: q.branch, prompt: q.prompt, key: q.stepKey })
  if (autoAnswer !== undefined && (engine.o.autoApprove || autoBy)) {
    engine.log(`? ${q.prompt}\n  -> ${autoAnswer} (${autoBy ?? "auto-approve"})`)
    await answerQuestion(engine, q.id, autoAnswer, autoMessage, autoBy ?? "human")
  } else {
    engine.log(`? [${q.id}] ${q.prompt}\n  options: ${q.options.map((o) => o.id).join(" | ")}  (answer with: slate inbox)`)
    engine.o.onQuestion?.(q)
  }
  return q
}

/** Waits until the question is answered, honoring stop requests and `autonomy.on_timeout`. */
export async function waitForAnswer(engine: Engine, id: string): Promise<string> {
  const timeoutMs = engine.o.project.autonomy.question_timeout_hours * 3_600_000
  while (true) {
    const q = engine.state.questions.find((x) => x.id === id)
    if (!q) throw new JobFailed(`question ${id} vanished`)
    if (q.answered) {
      const stillWorking = [...engine.running.values()].some((r) => r.branch === q.branch)
      await engine.o.state.update((s) => {
        const b = s.branches[q.branch]
        if (b && b.blockedOn === id) touchBranch(s, q.branch, { status: stillWorking ? "running" : "idle", blockedOn: undefined })
        syncJobStatus(s)
      })
      return q.answered.answer
    }
    if (engine.stopRequested) throw new StopSignal(engine.stopRequested === "hard", engine.stopReason ?? `stopped while waiting on question ${id}`)
    await pollAnswers(engine)
    if (timeoutMs > 0 && Date.now() - Date.parse(q.created) > timeoutMs) {
      const policy = engine.o.project.autonomy.on_timeout
      if (policy === "take-default") {
        const def = q.options.find((o) => o.default) ?? q.options[0]
        if (def) {
          engine.log(`question ${id} timed out after ${formatDuration(timeoutMs)}; taking default '${def.id}'`)
          await answerQuestion(engine, id, def.id, "timeout: default taken", "timeout")
          continue
        }
      } else if (policy === "escalate" && !q.context.includes("ESCALATED")) {
        await engine.o.state.update((s) => s.questions.find((x) => x.id === id)?.context.push("ESCALATED"))
        engine.log(`!! question ${id} has waited ${formatDuration(timeoutMs)} with no answer: ${q.prompt}`)
      }
    }
    await sleep(engine.pollMs)
  }
}

/** Records an answer. Permission asks and forms are also replied to in the agent's session. */
export async function answerQuestion(engine: Engine, id: string, answer: string, message?: string, by: NonNullable<Question["answered"]>["by"] = "human"): Promise<boolean> {
  const q = engine.state.questions.find((x) => x.id === id)
  if (!q || q.answered) return false
  await engine.o.state.update((s) => {
    const qq = s.questions.find((x) => x.id === id)
    if (qq) qq.answered = { at: nowIso(), answer, message, by }
  })
  engine.o.audit.append({ type: "question.answered", id, answer, message })
  if (q.kind === "permission" || q.kind === "form") {
    const decision = answer === "reject" || answer === "deny" ? "reject" : answer === "always" ? "always" : "once"
    await engine.o.runtime.reply({ sessionID: q.sessionID!, requestID: q.requestID!, kind: q.kind, decision, message, answer: q.kind === "form" ? { answer } : undefined })
  }
  return true
}

/** Other processes answer through files: .slate/answers/<qid>.json = { answer, message? }. */
export async function pollAnswers(engine: Engine): Promise<void> {
  const dir = engine.o.paths.answers
  for (const f of await listDir(dir)) {
    if (!f.endsWith(".json")) continue
    const id = f.slice(0, -5)
    if (engine.answersSeen.has(id)) continue
    const data = await readJsonOr<{ answer?: string; message?: string } | undefined>(path.join(dir, f), undefined)
    if (!data?.answer) continue
    engine.answersSeen.add(id)
    if (await answerQuestion(engine, id, data.answer, data.message)) engine.log(`answer received for ${id}: ${data.answer}`)
    await removePath(path.join(dir, f))
  }
}

/** An agent's permission ask or form becomes a question on the step's branch. */
export async function relayRuntimeQuestion(engine: Engine, rq: RuntimeQuestion, ctx: Ctx, step: SkillStep, key: string): Promise<void> {
  const q = await openQuestion(engine, {
    kind: rq.kind,
    prompt: rq.kind === "permission" ? `Agent ${step.by} in ${step.id} asks permission: ${rq.action} ${(rq.resources ?? []).join(" ")}${rq.message ? ` — ${rq.message}` : ""}` : `Agent ${step.by} in ${step.id} asks: ${rq.title ?? rq.message ?? "(form)"}`,
    context: rq.kind === "form" ? [JSON.stringify(rq.fields, null, 2).slice(0, 2000)] : [],
    options: rq.kind === "permission" ? [{ id: "once", label: "allow once" }, { id: "always", label: "allow always" }, { id: "reject", label: "reject" }] : [],
    branch: ctx.branch,
    stepKey: key,
    step: step.id,
    story: ctx.vars.story,
    sessionID: rq.sessionID,
    requestID: rq.requestID,
    reviewerNotes: rq.reviewerNotes,
    freeText: rq.kind === "form",
    autoAnswer: engine.o.autoApprove && rq.kind === "permission" ? "once" : undefined,
  })
  void waitForAnswer(engine, q.id).catch(() => undefined)
}

/** `blocked` means: a question is open and no branch is running a step, so nothing moves until you answer. */
export function syncJobStatus(s: JobState): void {
  if (s.status !== "running" && s.status !== "blocked") return
  const waiting = s.questions.some((q) => !q.answered)
  const working = Object.values(s.branches).some((b) => b.status === "running")
  s.status = waiting && !working ? "blocked" : "running"
}
