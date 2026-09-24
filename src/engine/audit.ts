import { appendText, readTextOr } from "../util/fs.ts"
import type { AuditEvent, AuditRecord } from "./types.ts"

export class AuditLog {
  private seq = 0
  private chain: Promise<void> = Promise.resolve()
  constructor(public readonly path: string, private readonly job: string, private readonly echo?: (r: AuditRecord) => void) {}

  static async open(path: string, job: string, echo?: (r: AuditRecord) => void): Promise<AuditLog> {
    const log = new AuditLog(path, job, echo)
    const existing = await AuditLog.read(path)
    log.seq = existing.length ? (existing[existing.length - 1]?.seq ?? 0) : 0
    return log
  }

  append(event: AuditEvent): void {
    const record: AuditRecord = { at: new Date().toISOString(), seq: ++this.seq, job: this.job, event }
    this.echo?.(record)
    this.chain = this.chain.then(() => appendText(this.path, JSON.stringify(record) + "\n")).catch(() => undefined)
  }

  async flush(): Promise<void> {
    await this.chain
  }

  static async read(path: string): Promise<AuditRecord[]> {
    const text = await readTextOr(path, "")
    const out: AuditRecord[] = []
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as AuditRecord)
      } catch {
        /* skip torn line */
      }
    }
    return out
  }
}
