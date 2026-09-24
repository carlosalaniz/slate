import path from "node:path"
import { isFile, readText } from "../util/fs.ts"
import { readField } from "../util/frontmatter.ts"
import { VERDICTS, type Verdict } from "../pack/schema.ts"
import { resolveRuntime } from "./vars.ts"
import { renderPrompt } from "./core-pack.ts"
import type { CorePack } from "./types.ts"

export interface ContractCheck {
  ok: boolean
  missing: string[]
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
  for (const w of input.writes) {
    const rel = resolveRuntime(w, input.vars)
    if (!(await isFile(path.resolve(input.directory, rel)))) missing.push(rel)
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

/** Text sent back to the agent, once, when the contract failed (slate-core `prompts/reprompt.md`). */
export function repromptText(core: CorePack, check: ContractCheck, writes: string[], result?: { file: string; field: string }, vars: Record<string, string> = {}): string {
  return renderPrompt(core, "reprompt", {
    missing: check.missing.join(", "),
    writes: writes.map((w) => resolveRuntime(w, vars)).join(", "),
    result_file: result ? resolveRuntime(result.file, vars) : "",
    result_field: result?.field ?? "",
  })
}
