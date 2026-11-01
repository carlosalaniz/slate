export interface ParsedArgs {
  command: string | undefined
  positional: string[]
  flags: Record<string, string | boolean>
}

/** Switches that never take a value, so `--json image generation` keeps its words. */
const SWITCHES = new Set(["json", "yes", "help", "quiet", "detach", "dry-run", "now", "new", "continue", "restart", "here", "project", "show", "skip-check", "no-discover"])

/** Tiny parser: `--flag`, `--flag value`, `--flag=value`, `--no-flag`, `-y`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      const body = a.slice(2)
      const eq = body.indexOf("=")
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (body.startsWith("no-")) {
        flags[body.slice(3)] = false
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("-") && !SWITCHES.has(body)) {
        flags[body] = next
        i++
      } else flags[body] = true
      continue
    }
    if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) flags[ch] = true
      continue
    }
    positional.push(a)
  }
  const [command, ...rest] = positional
  return { command, positional: rest, flags }
}

export function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name]
  return typeof v === "string" ? v : undefined
}

export function bool(flags: ParsedArgs["flags"], name: string, short?: string): boolean {
  const v = flags[name] ?? (short ? flags[short] : undefined)
  return v === true || v === "true" || v === "1"
}

export function num(flags: ParsedArgs["flags"], name: string): number | undefined {
  const v = flags[name]
  if (typeof v !== "string") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
