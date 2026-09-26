/**
 * A story's worktree is a fresh checkout: ignored files such as node_modules are not there. This
 * runs the install command from specs/tech-spec.md (a line like "install command: `pnpm install`"),
 * else picks one from the lockfile when there is a package.json and no node_modules. A story that
 * runs in the project itself has its dependencies already. A failing install stops the job: every
 * build in the worktree would fail without it.
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, root, reply, broken } from "./lib.ts"

if (workspace === root) reply({ ok: true, note: "runs in the project itself" })

const spec = path.join(workspace, "specs", "tech-spec.md")
const fromSpec = fs.existsSync(spec) ? /install command[^`\n]*`([^`]+)`/i.exec(fs.readFileSync(spec, "utf8"))?.[1] : undefined
const has = (f: string) => fs.existsSync(path.join(workspace, f))
const byLockfile = () => {
  if (!has("package.json") || has("node_modules")) return undefined
  if (has("bun.lock") || has("bun.lockb")) return "bun install"
  if (has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile"
  if (has("yarn.lock")) return "yarn install --frozen-lockfile"
  if (has("package-lock.json")) return "npm ci"
  return "npm install"
}
const command = fromSpec ?? byLockfile()
if (!command) reply({ ok: true, note: "nothing to install" })

const run = Bun.spawnSync(["sh", "-c", command], { cwd: workspace, env: { ...process.env, CI: "1" }, stdout: "pipe", stderr: "pipe" })
if (run.exitCode !== 0) broken(`\`${command}\` failed in ${workspace}:\n${`${run.stdout}${run.stderr}`.trim().slice(-1500)}`)
reply({ ok: true, installed: command })
