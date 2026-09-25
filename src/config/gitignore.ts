import path from "node:path"
import { readTextOr, writeText } from "../util/fs.ts"

/**
 * Slate's block in the project's .gitignore: runtime files (state, logs, the OpenCode database,
 * worktrees) and the agent files `slate discover` regenerates stay out of git; the brief and plan
 * revisions are project documents and stay in.
 */
const MARKER = "# Slate (added by slate init)"
const BLOCK = [MARKER, ".slate/*", "!.slate/brief.md", "!.slate/plan-revisions.md", ".opencode/agents/slate-*.md"]

/** Adds the block once; returns false when it was already there. */
export async function ensureGitignore(root: string): Promise<boolean> {
  const file = path.join(root, ".gitignore")
  const current = await readTextOr(file, "")
  if (current.includes(MARKER)) return false
  const sep = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n"
  await writeText(file, current + sep + BLOCK.join("\n") + "\n")
  return true
}
