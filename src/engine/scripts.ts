import path from "node:path"
import type { ScriptSpec } from "../pack/schema.ts"
import { resolveRuntime } from "./vars.ts"

export interface ScriptRun {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  json?: Record<string, unknown>
  error?: string
  timedOut: boolean
}

/**
 * Runs a pack script. Layout: `scripts/<id>.yml` says how to run it; the code lives in
 * `scripts/scripts/` (TypeScript, run with bun). The contract: it prints exactly one JSON object on stdout and exits 0.
 * Nonzero exit means the script itself is broken (infrastructure), never a failed check.
 */
export async function runScript(input: {
  script: ScriptSpec
  packDir: string
  workspace: string
  args: string[]
  vars: Record<string, string>
  run: string
  extraEnv?: Record<string, string>
}): Promise<ScriptRun> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SLATE_WORKSPACE: input.workspace,
    SLATE_RUN: input.run,
    SLATE_PACK: input.packDir,
    // Pack scripts are TypeScript run with `bun`; make sure the bun running Slate is found first.
    PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    ...input.extraEnv,
  }
  for (const [k, v] of Object.entries(input.vars)) env[`SLATE_VAR_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = v
  const cmd = resolveRuntime(input.script.run, input.vars)
  const args = input.args.map((a) => resolveRuntime(a, input.vars))
  const shellLine = [cmd, ...args.map(shellQuote)].join(" ")
  const proc = Bun.spawn(["sh", "-c", shellLine], {
    cwd: input.workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, input.script.timeoutMs)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  clearTimeout(timer)
  if (timedOut) return { ok: false, exitCode, stdout, stderr, timedOut, error: `script timed out after ${input.script.timeoutMs}ms` }
  if (exitCode !== 0) return { ok: false, exitCode, stdout, stderr, timedOut, error: `script exited ${exitCode}: ${stderr.trim() || stdout.trim()}`.slice(0, 2000) }
  const json = extractJson(stdout)
  if (!json) return { ok: false, exitCode, stdout, stderr, timedOut, error: `script printed no JSON object: ${stdout.trim().slice(0, 500)}` }
  return { ok: true, exitCode, stdout, stderr, timedOut, json }
}

function extractJson(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split("\n").reverse()
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      /* keep looking */
    }
  }
  try {
    const v = JSON.parse(stdout.trim())
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* no */
  }
  return undefined
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./=:@%+-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function scriptCwd(packDir: string, rel: string): string {
  return path.resolve(packDir, rel)
}
