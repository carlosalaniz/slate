import path from "node:path"
import { isDir, removePath } from "./fs.ts"

/**
 * Worktrees with plain git, not OpenCode's worktree API: that one nests the checkout one level down
 * (<dir>/<name>) on a detached HEAD, so there is no `slate/<name>` branch to merge.
 */

/** True when `directory` is the top of a git repository (a subdirectory of one does not count). */
export function isGitRoot(directory: string): Promise<boolean> {
  return isDir(path.join(directory, ".git"))
}

/** Checks out branch `slate/<name>` (created or reset at the source's HEAD) in `dir`. Returns the error text on failure. */
export async function addWorktree(sourceDirectory: string, dir: string, name: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "worktree", "add", "-B", `slate/${name}`, dir], { cwd: sourceDirectory, stdout: "pipe", stderr: "pipe" })
  if ((await proc.exited) === 0) return undefined
  return (await new Response(proc.stderr).text()).trim() || "git worktree add failed"
}

/** Removes the worktree, then its `slate/<name>` branch when that is merged (`-d` keeps unmerged work). */
export async function removeWorktree(root: string, directory: string): Promise<void> {
  const branch = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], { cwd: directory, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
  const proc = Bun.spawn(["git", "worktree", "remove", "--force", directory], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if ((await proc.exited) !== 0) await removePath(directory)
  if (branch.startsWith("slate/")) Bun.spawnSync(["git", "branch", "-d", branch], { cwd: root, stdout: "pipe", stderr: "pipe" })
}
