import path from "node:path"
import { writeJsonAtomic } from "../util/fs.ts"

/**
 * What each live agent session is doing right now, for `slate status`. The engine process records
 * it from OpenCode's event stream and writes `.slate/activity.json`; status (usually another
 * process) reads it. Sessions form a tree: a step's session, its consults and their children.
 */

export interface SessionActivity {
  sessionID: string
  /** Step key of the root session; children inherit it. */
  key: string
  agent: string
  parent?: string
  /** Short description of the latest action, e.g. "shell: npm test". */
  action: string
  since: string
  /** What to pass to `slate log` for this session's history. */
  log: string
  done?: boolean
}

export interface ActivityFile {
  updated: string
  sessions: Record<string, SessionActivity>
}

export class ActivityTracker {
  private sessions = new Map<string, SessionActivity>()
  private toolNames = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly file: string, private readonly root: string) {}

  /** A session Slate started: a step (no parent) or a consult. */
  register(s: Omit<SessionActivity, "action" | "since" | "done">): void {
    this.sessions.set(s.sessionID, { ...s, action: "starting", since: new Date().toISOString() })
    this.flush()
  }

  end(sessionID: string): void {
    const s = this.sessions.get(sessionID)
    if (!s) return
    // The session and everything under it.
    const mark = (id: string) => {
      this.sessions.get(id)!.done = true
      for (const c of this.sessions.values()) if (c.parent === id && !c.done) mark(c.sessionID)
    }
    mark(sessionID)
    this.flush()
  }

  /** Updates the tree from one OpenCode event. */
  handle(ev: any): void {
    const d = ev?.data
    const sessionID: string | undefined = d?.sessionID
    if (!sessionID) return
    // A child session (e.g. a subagent) of a tracked session joins the tree.
    if (ev.type === "session.created" && d.parentID && this.sessions.has(d.parentID) && !this.sessions.has(sessionID)) {
      const parent = this.sessions.get(d.parentID)!
      this.register({ sessionID, key: parent.key, agent: String(d.agent ?? "subagent"), parent: d.parentID, log: parent.log })
      return
    }
    const s = this.sessions.get(sessionID)
    if (!s) return
    let action: string | undefined
    switch (ev.type) {
      case "session.tool.input.started":
        this.toolNames.set(d.id, String(d.name))
        return
      case "session.tool.called":
        action = describeTool(this.toolNames.get(d.id) ?? "tool", d.input ?? {}, this.root)
        break
      case "session.tool.failed":
        action = `failed: ${describeTool(this.toolNames.get(d.id) ?? "tool", {}, this.root)}`
        break
      case "session.reasoning.started":
        action = "thinking"
        break
      case "session.text.started":
        action = "writing"
        break
      case "permission.asked":
        action = `waiting on permission: ${d.action} ${(d.resources ?? []).join(" ")}`.trim()
        break
      case "session.idle":
        action = "idle"
        break
    }
    if (!action || action === s.action) return
    s.action = action.length > 100 ? action.slice(0, 99) + "…" : action
    s.since = new Date().toISOString()
    this.flush()
  }

  /** Writes at most every 500ms. */
  private flush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      // Finished trees drop out after the write that marks them done.
      const sessions = Object.fromEntries(this.sessions)
      for (const [id, s] of this.sessions) if (s.done) this.sessions.delete(id)
      void writeJsonAtomic(this.file, { updated: new Date().toISOString(), sessions } satisfies ActivityFile).catch(() => undefined)
    }, 500)
  }
}

/** "shell: npm test", "edit src/game.ts", "consult staff-engineer", ... */
export function describeTool(name: string, input: Record<string, any>, root: string): string {
  const rel = (p: unknown) => (typeof p === "string" ? (path.isAbsolute(p) ? path.relative(root, p) || "." : p) : "")
  const one = (s: unknown) => String(s ?? "").split("\n")[0]!.trim()
  switch (name) {
    case "shell":
    case "bash":
      return `shell: ${one(input.command)}`
    case "read":
    case "edit":
    case "write":
    case "patch":
      return `${name} ${rel(input.path ?? input.filePath)}`.trim()
    case "glob":
    case "grep":
      return `${name} ${one(input.pattern)}`.trim()
    case "consult":
      return `consult ${one(input.agent)}`.trim()
    case "subagent":
      return `subagent ${one(input.agent)}${input.description ? `: ${one(input.description)}` : ""}`
    case "question":
      return "asking you"
    default:
      return name
  }
}

/**
 * The live agent tree for `slate status`, one line per session, children indented under the
 * session that started them:
 *   checker · shell: npm test · 12s · slate log s1-t1
 *     └ staff-engineer · read specs/tech-spec.md · 3s · slate log s1-t1
 */
export function activityLines(file: ActivityFile, ageOf: (iso: string) => string): string[] {
  const live = Object.values(file.sessions).filter((s) => !s.done)
  const ids = new Set(live.map((s) => s.sessionID))
  const children = new Map<string, SessionActivity[]>()
  for (const s of live) if (s.parent && ids.has(s.parent)) children.set(s.parent, [...(children.get(s.parent) ?? []), s])
  const out: string[] = []
  const walk = (s: SessionActivity, depth: number) => {
    const lead = depth === 0 ? "  " : "  " + "  ".repeat(depth) + "└ "
    out.push(`${lead}${s.agent} · ${s.action} · ${ageOf(s.since)} · slate log ${s.log}`)
    for (const c of children.get(s.sessionID) ?? []) walk(c, depth + 1)
  }
  for (const root of live.filter((s) => !s.parent || !ids.has(s.parent)).sort((a, b) => a.key.localeCompare(b.key))) walk(root, 0)
  return out
}
