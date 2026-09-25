import path from "node:path"
import { Engine } from "../../engine/engine.ts"
import { StateStore } from "../../engine/state.ts"
import { AuditLog } from "../../engine/audit.ts"
import { newJobState, type JobState, type Runtime } from "../../engine/types.ts"
import { FakeRuntime } from "../../opencode/fake.ts"
import { OpenCodeRuntime } from "../../opencode/adapter.ts"
import { listInstalledPacks, findPack, type InstalledPack } from "../../pack/registry.ts"
import { loadPack } from "../../pack/loader.ts"
import { ensureDir, writeText, removePath } from "../../util/fs.ts"
import { shortId, slug } from "../../util/id.ts"
import type { ProjectCtx } from "../context.ts"
import { CliError, type Output } from "../output.ts"
import { logLine } from "../prompt.ts"
import { answerInline } from "../questions.ts"

export interface RunOptions {
  dryRun: boolean
  autoApprove: boolean
  quiet: boolean
  packRef?: string
  idea?: string
  briefPath?: string
  /** Pack chosen in a finished discovery: the job starts at the plan phase with it pinned. */
  discovered?: InstalledPack
}

export function makeRuntime(p: ProjectCtx, dryRun: boolean, log: (l: string) => void): Runtime {
  if (dryRun) return new FakeRuntime({ costPerStep: 0.02 })
  return new OpenCodeRuntime({ log, worktreeStrategy: p.config.runtime.worktrees })
}

/** Creates state.json for a new job. Fails if one is already open. */
export async function createJob(p: ProjectCtx, opts: RunOptions): Promise<StateStore> {
  const existing = await StateStore.read(p.paths.state)
  if (existing && existing.status !== "done" && existing.status !== "failed") {
    throw new CliError(`a job is already open (${existing.job.id}, ${existing.status})`, "use `slate continue`, or `slate stop` then remove .slate/state.json to start over. See --help.")
  }
  if (existing) {
    // Archive the finished job's state next to the log so history survives.
    await writeText(path.join(p.paths.slate, `state.${existing.job.id}.json`), JSON.stringify(existing, null, 2))
    // A finished discovery's brief belongs to this new job; otherwise it is the old job's.
    if (!opts.discovered) await removePath(p.paths.brief)
    await removePath(p.paths.answers)
  }
  await ensureDir(p.paths.slate)
  await ensureDir(p.paths.answers)
  await ensureDir(p.paths.control)
  const state: JobState = newJobState({ id: shortId(slug(p.config.name)), name: p.config.name, opencode: p.config.opencode, runtime: opts.dryRun ? "fake" : "opencode", idea: opts.idea })
  // Saved so `slate continue` and the background engine keep the autonomy chosen at start.
  state.job.autonomy = opts.autoApprove ? "unattended" : "supervised"
  if (opts.discovered) {
    // Discovery already wrote the brief and the discovery documents with the user.
    state.job.pack = { name: opts.discovered.name, version: opts.discovered.version, dir: opts.discovered.dir }
    state.phase = "plan"
  }
  if (opts.briefPath) {
    const text = await Bun.file(opts.briefPath).text()
    await writeText(p.paths.brief, text)
  }
  return StateStore.create(p.paths.state, state)
}

export async function buildEngine(p: ProjectCtx, store: StateStore, opts: RunOptions, out: Output): Promise<Engine> {
  const state = store.get()
  const log = (line: string) => {
    if (!opts.quiet && !out.json) logLine(line)
  }
  const runtime = makeRuntime(p, state.job.runtime === "fake" || opts.dryRun, log)
  const audit = await AuditLog.open(p.paths.log, state.job.id)
  const installed = await listInstalledPacks(p.root)
  let pack
  const ref = opts.packRef ?? state.job.pack?.dir ?? p.config.pack
  if (ref) {
    const found = state.job.pack?.dir && !opts.packRef ? { dir: state.job.pack.dir } : await findPack(ref, p.root)
    if (!found) throw new CliError(`pack '${ref}' is not installed`, "run `slate pack list`, or `slate pack add <dir>`")
    pack = await loadPack(found.dir, p.config.config)
  }
  return new Engine({
    root: p.root,
    paths: p.paths,
    runtime,
    project: p.config,
    state: store,
    audit,
    installedPacks: installed,
    pack,
    autoApprove: opts.autoApprove || state.job.autonomy === "unattended" || p.config.autonomy.auto_approve,
    log,
  })
}

/** Runs the engine in this process, writing the pid file so other commands can find it. */
export async function runForeground(p: ProjectCtx, store: StateStore, opts: RunOptions, out: Output): Promise<JobState> {
  await writeText(p.paths.pid, String(process.pid) + "\n")
  const engine = await buildEngine(p, store, opts, out)
  const onSignal = () => {
    out.line("\nstopping after the current step (press Ctrl-C again to interrupt now)")
    engine.requestStop(false)
    process.once("SIGINT", () => engine.requestStop(true))
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", () => engine.requestStop(false))
  // Attached in a terminal: questions are asked inline with a picker as they appear.
  const stopAsking = process.stdin.isTTY && !out.json && !opts.quiet ? answerInline(p.paths) : undefined
  try {
    return await engine.run()
  } finally {
    stopAsking?.()
    await removePath(p.paths.pid)
  }
}

/** Spawns a detached engine process that survives this terminal. */
export async function runDetached(p: ProjectCtx, opts: RunOptions): Promise<number> {
  const bin = path.resolve(import.meta.dir, "..", "..", "..", "bin", "slate.ts")
  const args = [process.execPath, bin, "_run", ...(opts.dryRun ? ["--dry-run"] : []), ...(opts.autoApprove ? ["--yes"] : [])]
  const logFile = Bun.file(p.paths.engineLog)
  const proc = Bun.spawn(args, {
    cwd: p.root,
    stdout: logFile,
    stderr: logFile,
    stdin: "ignore",
    env: process.env,
  })
  proc.unref()
  await writeText(p.paths.pid, String(proc.pid) + "\n")
  return proc.pid
}
