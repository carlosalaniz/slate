import type { AgentSpec, ConsultPolicy } from "../pack/schema.ts"
import type { AuditEvent, ResolvedGate, RuntimeQuestion } from "../engine/types.ts"

/** In-process map from OpenCode session id to the Slate step that owns it. Shared by adapter and plugin. */
export interface SessionEntry {
  sessionID: string
  key: string
  stepId: string
  phase: string
  agent: AgentSpec
  directory: string
  vars: Record<string, string>
  consult?: ConsultPolicy
  consultsMade: number
  children: string[]
  gates: ResolvedGate[]
  role: "worker" | "consultant"
  parent?: string
  reviewerNotes: string[]
  onAudit?: (e: AuditEvent) => void
  onQuestion?: (q: RuntimeQuestion) => void
}

export class SessionRegistry {
  private entries = new Map<string, SessionEntry>()
  /** Called for every session Slate starts (steps and consults); the adapter tracks activity with it. */
  onSet?: (entry: SessionEntry) => void
  set(entry: SessionEntry): void {
    this.entries.set(entry.sessionID, entry)
    this.onSet?.(entry)
  }
  get(sessionID: string): SessionEntry | undefined {
    return this.entries.get(sessionID)
  }
  delete(sessionID: string): void {
    this.entries.delete(sessionID)
  }
  all(): SessionEntry[] {
    return [...this.entries.values()]
  }
}
