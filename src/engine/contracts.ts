import path from "node:path"
import YAML from "yaml"
import { isFile, readText } from "../util/fs.ts"
import { readField } from "../util/frontmatter.ts"
import { VERDICTS, type Verdict } from "../pack/schema.ts"
import { resolveRuntime } from "./vars.ts"
import { renderPrompt } from "./core-pack.ts"
import type { CorePack } from "./types.ts"

export interface ContractCheck {
  ok: boolean
  missing: string[]
  /** Declared YAML/JSON outputs that exist but do not parse, with the parser's message. */
  invalid?: { file: string; error: string }[]
  verdict?: Verdict
  verdictRaw?: unknown
  reason?: string
  resultFile?: string
}

/**
 * The fix for the silent no-op: after a session ends, every declared `writes` file must exist and
 * the `result` field, when declared, must be exactly `pass` or `fail`. Nothing here asks a model.
 */
export async function checkContracts(input: {
  directory: string
  writes: string[]
  result?: { file: string; field: string }
  vars: Record<string, string>
}): Promise<ContractCheck> {
  const missing: string[] = []
  const invalid: { file: string; error: string }[] = []
  for (const w of input.writes) {
    const rel = resolveRuntime(w, input.vars)
    const abs = path.resolve(input.directory, rel)
    if (!(await isFile(abs))) missing.push(rel)
    else {
      // Later steps and pack scripts read these; a file that does not parse is not an output.
      const error = parseError(rel, await readText(abs))
      if (error) invalid.push({ file: rel, error })
    }
  }
  if (invalid.length) {
    return { ok: false, missing, invalid, reason: `invalid output: ${invalid.map((i) => `${i.file} (${i.error})`).join("; ")}` }
  }
  if (!input.result) {
    return missing.length ? { ok: false, missing, reason: `missing output: ${missing.join(", ")}` } : { ok: true, missing }
  }
  const rel = resolveRuntime(input.result.file, input.vars)
  const abs = path.resolve(input.directory, rel)
  if (!(await isFile(abs))) {
    if (!missing.includes(rel)) missing.push(rel)
    return { ok: false, missing, reason: `missing result file: ${rel}`, resultFile: rel }
  }
  const raw = readField(await readText(abs), input.result.field)
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : raw === true ? "pass" : raw === false ? "fail" : undefined
  if (normalized !== "pass" && normalized !== "fail") {
    return {
      ok: false,
      missing,
      verdictRaw: raw,
      resultFile: rel,
      reason: `field '${input.result.field}' in ${rel} must be one of ${VERDICTS.join("|")}, got ${JSON.stringify(raw ?? null)}`,
    }
  }
  if (missing.length) return { ok: false, missing, verdict: normalized, resultFile: rel, reason: `missing output: ${missing.join(", ")}` }
  return { ok: true, missing, verdict: normalized, verdictRaw: raw, resultFile: rel }
}

/** Why a .yaml/.yml/.json output does not parse (with line and column when known), or undefined. */
export function parseError(file: string, text: string): string | undefined {
  if (/\.json$/i.test(file)) {
    try {
      JSON.parse(text)
      return undefined
    } catch (e) {
      return (e as Error).message
    }
  }
  if (!/\.ya?ml$/i.test(file)) return undefined
  try {
    // The parser pack scripts use (`Bun.YAML`) decides; the `yaml` library explains where.
    Bun.YAML.parse(text)
    return undefined
  } catch (e) {
    const detail = YAML.parseDocument(text).errors[0]
    if (!detail) return (e as Error).message
    const [line, col] = detail.linePos?.[0] ? [detail.linePos[0].line, detail.linePos[0].col] : []
    return `${line ? `line ${line}, column ${col}: ` : ""}${detail.message.split("\n")[0]}`
  }
}

/** Text sent back to the agent, once, when the contract failed (slate-core `prompts/reprompt.md`). */
export function repromptText(core: CorePack, check: ContractCheck, writes: string[], result?: { file: string; field: string }, vars: Record<string, string> = {}): string {
  return renderPrompt(core, "reprompt", {
    missing: check.missing.join(", "),
    invalid: (check.invalid ?? []).map((i) => `${i.file}: ${i.error}`).join("; "),
    writes: writes.map((w) => resolveRuntime(w, vars)).join(", "),
    result_file: result ? resolveRuntime(result.file, vars) : "",
    result_field: result?.field ?? "",
  })
}
