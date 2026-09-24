export class Output {
  constructor(public readonly json: boolean) {}

  /** Prints a human view or a JSON document depending on --json. */
  emit(human: () => string | string[], data: unknown): void {
    if (this.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n")
      return
    }
    const h = human()
    process.stdout.write((Array.isArray(h) ? h.join("\n") : h) + "\n")
  }

  line(s: string): void {
    if (!this.json) process.stdout.write(s + "\n")
  }

  err(s: string): void {
    process.stderr.write(s + "\n")
  }
}

export function table(rows: string[][], opts: { header?: string[]; indent?: string } = {}): string[] {
  const all = opts.header ? [opts.header, ...rows] : rows
  const widths: number[] = []
  for (const r of all) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
  const fmt = (r: string[]) => (opts.indent ?? "") + r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd()
  const out: string[] = []
  if (opts.header) {
    out.push(fmt(opts.header))
    out.push((opts.indent ?? "") + widths.map((w) => "-".repeat(w)).join("  "))
  }
  for (const r of rows) out.push(fmt(r))
  return out
}

export class CliError extends Error {
  constructor(message: string, public readonly hint?: string, public readonly code = 1) {
    super(message)
    this.name = "CliError"
  }
}
