import path from "node:path"
import { readTextOr, writeText } from "../util/fs.ts"

/**
 * Slate's block in the project's .gitignore: runtime files (state, logs, the OpenCode database,
 * worktrees) and the agent files `slate discover` regenerates stay out of git; the brief and plan
 * revisions are project documents and stay in.
 */
const MARKER = "# Slate (added by slate init)"
const BLOCK = [MARKER, ".slate/*", "!.slate/brief.md", "!.slate/plan-revisions.md", "!.slate/installed/", ".opencode/agents/slate-*.md"]

/** Adds the block once, or the lines a newer Slate added to it; returns false when nothing changed. */
export async function ensureGitignore(root: string): Promise<boolean> {
  const file = path.join(root, ".gitignore")
  const current = await readTextOr(file, "")
  if (current.includes(MARKER)) {
    const lines = current.split("\n")
    const missing = BLOCK.filter((l) => !lines.includes(l))
    if (!missing.length) return false
    const at = lines.indexOf(MARKER)
    let end = at + 1
    while (end < lines.length && lines[end]!.trim() && !lines[end]!.startsWith("#")) end++
    lines.splice(end, 0, ...missing)
    await writeText(file, lines.join("\n"))
    return true
  }
  const sep = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n"
  await writeText(file, current + sep + BLOCK.join("\n") + "\n")
  return true
}
