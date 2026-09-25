import path from "node:path"
import os from "node:os"

/** Layout of a Slate project. Everything Slate owns lives under `.slate/`. */
export function projectPaths(root: string) {
  const slate = path.join(root, ".slate")
  return {
    root,
    slate,
    config: path.join(root, "slate.config.yml"),
    state: path.join(slate, "state.json"),
    log: path.join(slate, "log.jsonl"),
    brief: path.join(slate, "brief.md"),
    discovery: path.join(slate, "discovery.json"),
    engineLog: path.join(slate, "engine.log"),
    pid: path.join(slate, "engine.pid"),
    control: path.join(slate, "control"),
    answers: path.join(slate, "answers"),
    consults: path.join(slate, "consults"),
    sessions: path.join(slate, "sessions"),
    worktrees: path.join(slate, "worktrees"),
    skills: path.join(slate, "skills"),
    packs: path.join(slate, "packs"),
    db: path.join(slate, "opencode.db"),
    planRevisions: path.join(slate, "plan-revisions.md"),
  }
}
export type ProjectPaths = ReturnType<typeof projectPaths>

export function userPacksDir(): string {
  return process.env.SLATE_PACKS_DIR ?? path.join(os.homedir(), ".slate", "packs")
}

/** Packs bundled with the Slate source tree. */
export function bundledPacksDir(): string {
  return path.resolve(import.meta.dir, "..", "..", "packs")
}
