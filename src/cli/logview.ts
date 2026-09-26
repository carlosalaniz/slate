import type { ProjectPaths } from "../config/paths.ts"
import type { AuditEvent } from "../engine/types.ts"
import { AuditLog } from "../engine/audit.ts"
import type { ActivityFile, SessionActivity } from "../opencode/activity.ts"
import { readTextOr } from "../util/fs.ts"
import { usd } from "../util/time.ts"
import { logLine } from "./prompt.ts"

/**
 * The job's progress as people read it: agent first, subagents nested under the agent that started
 * them, the story or task as a short tag at the end.
 *
 *   01:43:01  architect                   starts write-tdd                   s1
 *   01:43:04  architect                   read specs/tech-spec.md            s1
 *   01:43:09  architect › staff-engineer  answered consult #1: pass          s1
 *   01:42:55  slate                       design round 2/2                   s1
 *
 * Built from the audit log (what happened) and `.slate/activity.json` (what each agent is doing
 * right now), so the foreground run and `slate continue` attached to a background run look the same.
 */
export class LogView {
  /** Step key -> the agent running it and its tag. */
  private steps = new Map<string, { agent?: string; tag?: string }>()
  /** Permission questions not answered yet, shown as one line once answered. */
  private pendingPermissions = new Map<string, { key?: string; agent?: string; what: string; at: string }>()
  private lastAction = new Map<string, string>()
  /** "build/story-loop[0]" -> "s1": what each over-loop iteration is working on. */
  private iterations = new Map<string, string>()

  /**
   * Lines for a batch of audit records, in order. `only` limits which records print (the rest still
   * teach the view which agent runs which step), as `slate log <task>` does.
   */
  events(records: { at: string; event: AuditEvent }[], only?: Set<unknown>): string[] {
    const out: string[] = []
    for (const r of records) {
      const lines = this.event(r.at, r.event)
      if (!only || only.has(r)) out.push(...lines)
    }
    // Permissions answered in the same batch (auto-approved) were folded into one line; the rest wait on a person.
    for (const [id, p] of this.pendingPermissions) {
      if (p.at === "shown") continue
      out.push(this.line(p.at, p.key ? this.actor(p.key) : (p.agent ?? "slate"), `waiting on you: permission ${p.what} [${id}]`, this.tag(p.key)))
      p.at = "shown"
    }
    return out
  }

  /** Lines for agents whose current action changed since the last call (tool calls and waits only). */
  activity(file: ActivityFile | undefined): string[] {
    if (!file) return []
    const sessions = file.sessions
    const path = (s: SessionActivity): string => {
      const parent = s.parent ? sessions[s.parent] : undefined
      return parent ? `${path(parent)} › ${s.agent}` : s.agent
    }
    const out: string[] = []
    for (const s of Object.values(sessions)) {
      if (s.done || QUIET_ACTIONS.has(s.action) || this.lastAction.get(s.sessionID) === s.action) continue
      this.lastAction.set(s.sessionID, s.action)
      out.push(this.line(s.since, path(s), s.action, s.log))
    }
    return out
  }

  private event(at: string, e: AuditEvent): string[] {
    const key = "key" in e ? (e.key as string | undefined) : undefined
    const actor = this.actor(key)
    const tag = this.tag(key)
    const one = (action: string, who = actor) => [this.line(at, who, action, tag)]
    switch (e.type) {
      case "step.start":
        this.steps.set(e.key, { agent: e.agent, tag: e.vars?.task ?? e.vars?.story })
        return e.agent ? [this.line(at, e.agent, `starts ${e.step}`, this.tag(e.key))] : []
      case "step.end":
        return one(`${e.step} ${e.status}${e.cost ? ` ${usd(e.cost)}` : ""}${e.reason ? ` — ${firstLine(e.reason)}` : ""}`)
      case "verdict":
        return one(`verdict ${e.verdict} (${e.file})`)
      case "consult":
        return one(`answered consult #${e.n}: ${e.verdict}`, `${actor} › ${e.consultant}`)
      case "gate":
        return one(`gate ${e.action} ${e.resource} → ${e.decision}${e.reviewers.length ? ` (${e.reviewers.map((r) => `${r.id}: ${r.decision}`).join(", ")})` : ""}`)
      case "infra.retry":
        return one(`retry ${e.attempt} after: ${firstLine(e.error)}`)
      case "contract.failed":
        return one(`output check failed: ${firstLine(e.reason)}${e.reprompt ? " (asked to fix it)" : ""}`)
      case "script":
        return one(e.ok ? "ok" : `broken: ${firstLine(e.error ?? "")}`, `script ${e.script}`)
      case "loop.round":
        return one(`${loopName(e.loop)} round ${e.round}/${e.max}`, "slate")
      case "loop.iteration":
        this.iterations.set(`${e.key}[${e.iteration}]`, e.value)
        return [this.line(at, "slate", `${loopName(e.loop)} → ${e.value}`, e.value)]
      case "loop.exhausted":
        return one(`${loopName(e.loop)} out of rounds → ${e.policy}`, "slate")
      case "question.open": {
        const permission = /asks permission: (.*)$/s.exec(e.prompt)?.[1]
        if (e.kind === "permission" && permission) {
          // Older logs have no step key on questions; the prompt still names the agent.
          const agent = /^Agent (\S+) in /.exec(e.prompt)?.[1]
          this.pendingPermissions.set(e.id, { key: e.key, agent, what: firstLine(permission), at })
          return []
        }
        return [this.line(at, this.actor(e.key), `asks you: ${firstLine(e.prompt)} [${e.id}]`, this.tag(e.key))]
      }
      case "question.answered": {
        const p = this.pendingPermissions.get(e.id)
        if (p) {
          this.pendingPermissions.delete(e.id)
          return [this.line(at, p.key ? this.actor(p.key) : (p.agent ?? "slate"), `permission ${p.what} → ${e.answer}`, this.tag(p.key))]
        }
        return [this.line(at, "you", `answered ${e.id}: ${e.answer}${e.message ? ` — ${e.message}` : ""}`)]
      }
      case "budget":
        return one(`budget reached for ${e.scope}: ${usd(e.spent)} of ${usd(e.cap)} → stopped`, "slate")
      case "job":
        return one(`job ${e.status}${e.phase ? ` (${e.phase})` : ""}${e.reason ? ` — ${firstLine(e.reason)}` : ""}`, "slate")
      case "plan.revise":
        return one(`plan revision: ${e.note}`, "slate")
      case "worktree":
      case "session":
        return []
      default:
        return []
    }
  }

  /** The agent running a step key (or its closest known parent step), else "slate". */
  private actor(key?: string): string {
    return this.lookup(key)?.agent ?? "slate"
  }

  private tag(key?: string): string | undefined {
    const known = this.lookup(key)?.tag
    if (known || !key) return known
    // Inside over-loop iterations: the innermost item (the task inside a story).
    let best: [string, string] | undefined
    for (const [prefix, value] of this.iterations) {
      if ((key === prefix || key.startsWith(prefix + "/")) && prefix.length > (best?.[0].length ?? -1)) best = [prefix, value]
    }
    return best?.[1]
  }

  private lookup(key?: string): { agent?: string; tag?: string } | undefined {
    for (let k = key; k; k = k.includes("/") ? k.slice(0, k.lastIndexOf("/")) : undefined) {
      const s = this.steps.get(k)
      if (s) return s
    }
    return undefined
  }

  private line(at: string, actor: string, action: string, tag?: string): string {
    const time = at.length >= 19 ? at.slice(11, 19) : at
    return `${time}  ${actor.padEnd(26)} ${action}${tag ? `  · ${tag}` : ""}`
  }
}

/** Agent states that change constantly and say little; the log shows actions only. */
const QUIET_ACTIONS = new Set(["starting", "thinking", "writing", "idle"])

const firstLine = (s: string) => s.split("\n")[0]!.trim().slice(0, 160)

/** "build/story-loop[0]/design{2}/tdd" -> "tdd"; round markers dropped. */
const loopName = (key: string) => key.split("/").pop()!.replace(/[{[].*$/, "")

/**
 * Prints the job's progress with a LogView until stopped: new audit records and agent actions,
 * polled from disk (the engine may be this process or a background one). Starts after what is
 * already in the log unless `fromStart`.
 */
export function followJob(paths: ProjectPaths, opts: { fromStart?: boolean } = {}): { stop: () => Promise<void> } {
  const view = new LogView()
  let seen: number | undefined = opts.fromStart ? 0 : undefined
  let stopped = false
  const tick = async () => {
    const records = await AuditLog.read(paths.log).catch(() => [])
    if (seen === undefined) {
      // Learn the steps already running without printing old history.
      view.events(records)
      seen = records.length
    }
    for (const l of view.events(records.slice(seen))) logLine(l)
    seen = records.length
    let activity: ActivityFile | undefined
    try {
      activity = JSON.parse(await readTextOr(paths.activity, "")) as ActivityFile
    } catch {
      activity = undefined
    }
    for (const l of view.activity(activity)) logLine(l)
  }
  const loop = (async () => {
    while (!stopped) {
      await tick()
      await Bun.sleep(500)
    }
    await tick()
  })()
  return {
    stop: async () => {
      stopped = true
      await loop
    },
  }
}
