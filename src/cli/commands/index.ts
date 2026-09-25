import path from "node:path"
import YAML from "yaml"
import { register } from "../main.ts"
import { parseArgs, str, bool, num } from "../args.ts"
import { CliError, table, type Output } from "../output.ts"
import { requireProject, requireJob, isEngineAlive } from "../context.ts"
import { select, input, optionalNumber, spin, answered, logLine } from "../prompt.ts"
import { answerInline, pickAnswer, deliverAnswer, isValidAnswer } from "../questions.ts"
import { activityLines, type ActivityFile } from "../../opencode/activity.ts"
import { loadCatalog, defaultTiers, type CatalogModel } from "../../opencode/catalog.ts"
import { runDiscovery, readDiscovery, writeDiscovery, checkDiscovery, type DiscoveryCheck } from "../discovery.ts"
import { ProjectConfigSchema, saveProjectConfig, loadProjectConfig, type ProjectConfig } from "../../config/project.ts"
import { projectPaths } from "../../config/paths.ts"
import { ensureGitignore } from "../../config/gitignore.ts"
import { loadInitDefaults, DEFAULTS_FILE } from "../../config/init-defaults.ts"
import { readOpenCodeKeys } from "../../opencode/credentials.ts"
import { StateStore } from "../../engine/state.ts"
import { AuditLog } from "../../engine/audit.ts"
import type { Question, JobState } from "../../engine/types.ts"
import { listInstalledPacks, addPack, updatePack, validatePackDir, findPack } from "../../pack/registry.ts"
import { ensureDir, writeJsonAtomic, writeText, readTextOr, isFile, removePath } from "../../util/fs.ts"
import { ageOf, usd, sleep } from "../../util/time.ts"
import { createJob, runForeground, runDetached, makeRuntime, type RunOptions } from "./run-job.ts"

/* ---------------------------------------------------------------------- init */

register(
  "init",
  `slate init [--name X] [--provider anthropic] [--low M] [--medium M] [--high M] [--budget-job USD] [--budget-task USD]
           [--question-timeout HOURS] [--on-timeout keep-waiting|take-default|escalate]
           [--pack name[@version]] [--opencode VERSION] [--yes] [--no-discover]
Sets up the project, writes slate.config.yml, then opens discovery in OpenCode (see \`slate discover\`).
Runs non-interactively, without discovery, when --yes is set or there is no terminal.
The pack is chosen with you during discovery; --pack limits discovery to that one.
Budgets are optional: without --budget-job/--budget-task (or with 0) there is no cap.
Answers in a .slate_defaults.yml (project dir, its parents, or home) are used without asking; see config.example.yml.
Fails when a project is already initialized.`,
  async (argv, out) => {
    const { flags } = parseArgs(["init", ...argv])
    const root = process.cwd()
    const paths = projectPaths(root)
    if (await loadProjectConfig(root)) throw new CliError("project already initialized (slate.config.yml exists)", "edit slate.config.yml directly, or delete it to re-run init. See `slate init --help`.")
    const interactive = !bool(flags, "yes", "y") && process.stdin.isTTY && !out.json
    const flag = (name: string) => str(flags, name)
    const numFlag = (name: string) => num(flags, name)

    // Answers from .slate_defaults.yml are used without asking; flags still win.
    const found = await loadInitDefaults(root).catch((e: Error) => {
      throw new CliError(`invalid ${DEFAULTS_FILE}`, e.message)
    })
    const d = found?.values ?? {}
    if (found && !out.json) out.line(`using defaults from ${found.file}`)
    const preset = <T,>(label: string, value: T | undefined): T | undefined => {
      if (value !== undefined && interactive) answered(label, value === 0 && label.startsWith("budget") ? "no cap" : String(value))
      return value
    }

    const name = flag("name") ?? preset("project name", d.name) ?? (interactive ? await input("project name", { def: path.basename(root) }) : path.basename(root))

    const given = { provider: flag("provider") ?? d.provider, low: flag("low") ?? d.models?.low, medium: flag("medium") ?? d.models?.medium, high: flag("high") ?? d.models?.high }
    if (given.provider && given.low && given.medium && given.high && !flag("provider")) {
      preset("provider", given.provider)
      for (const t of ["low", "medium", "high"] as const) preset(`model for ${t} tier`, given[t])
    }
    const { provider, models, fromCatalog } = await chooseModels(interactive, given)

    // Budgets are optional: Enter (or no flag) means no cap.
    const budgetJob = numFlag("budget-job") ?? preset("budget per job (USD)", d.budget?.job) ?? (interactive ? await optionalNumber("budget per job (USD)") : undefined)
    const budgetTask = numFlag("budget-task") ?? preset("budget per task (USD)", d.budget?.per_task) ?? (interactive ? await optionalNumber("budget per task (USD)") : undefined)

    // No pack by default: it is chosen with the user during discovery. --pack limits the choice to one.
    const pack = flag("pack") ?? d.pack

    const config: ProjectConfig = ProjectConfigSchema.parse({
      name,
      provider,
      models,
      budget: { job: budgetJob, per_task: budgetTask, per_model: d.budget?.per_model ?? {} },
      // Supervised or unattended is chosen per job at `slate start`; these apply to both.
      autonomy: {
        question_timeout_hours: numFlag("question-timeout") ?? d.autonomy?.question_timeout_hours ?? 8,
        on_timeout: flag("on-timeout") ?? d.autonomy?.on_timeout ?? "keep-waiting",
        auto_approve: false,
      },
      pack,
      opencode: flag("opencode") ?? d.opencode ?? "2.0.15",
      ...(d.runtime ? { runtime: d.runtime } : {}),
      ...(d.config ? { config: d.config } : {}),
    })
    await ensureDir(paths.slate)
    await saveProjectConfig(root, config)
    const gitignored = await ensureGitignore(root)
    let providerNote = ""
    if (!fromCatalog && !bool(flags, "skip-check") && !out.json) {
      // A key saved in OpenCode counts too: Slate reuses those (see opencode/credentials.ts).
      const key = process.env[`${config.provider.toUpperCase()}_API_KEY`] || readOpenCodeKeys().keys.some((k) => k.providerID === config.provider)
      if (!key) providerNote = `note: ${config.provider.toUpperCase()}_API_KEY is not set in this shell; OpenCode needs credentials for '${config.provider}' before \`slate start\`.`
    }
    out.emit(
      () => [`initialized ${config.name} in ${root}`, `  config: slate.config.yml`, ...(gitignored ? ["  .gitignore: added Slate's runtime files"] : []), `  pack:   ${config.pack ?? "(chosen with you during discovery)"}`, `  models: low=${config.models.low} medium=${config.models.medium} high=${config.models.high}`, ...(providerNote ? [providerNote] : [])],
      { root, config, note: providerNote || undefined },
    )
    if (!interactive || bool(flags, "no-discover") || d.discover === false) {
      out.line("next: `slate discover` to describe what to build, then `slate start`")
      return 0
    }
    out.line("")
    return reportDiscovery(await runDiscovery(paths, config), out)
  },
)

/* ------------------------------------------------------------------ discover */

register(
  "discover",
  `slate discover [--new]
Opens the discovery conversation in OpenCode. Slate's discovery agent interviews you, helps you pick
the workflow pack, then writes .slate/brief.md and the pack's discovery documents (for the reference
pack: specs/product-scope.md, specs/uiux-spec.md, specs/tech-spec.md). Quit OpenCode when it is done.
Running it again reopens the same conversation until those files exist; --new starts a fresh one.
Discovery always needs you present, so it needs a terminal.`,
  async (argv, out) => {
    const { flags } = parseArgs(["discover", ...argv])
    const p = await requireProject()
    if (!process.stdin.isTTY || out.json) throw new CliError("discovery is a live conversation and needs a terminal", "run `slate discover` in an interactive shell")
    return reportDiscovery(await runDiscovery(p.paths, p.config, { fresh: bool(flags, "new") }), out)
  },
)

function reportDiscovery(check: DiscoveryCheck, out: Output): number {
  if (check.done) {
    out.emit(() => [`discovery done: pack ${check.pack!.name}@${check.pack!.version}`, "next: `slate start` to plan and build"], { done: true, pack: `${check.pack!.name}@${check.pack!.version}` })
    return 0
  }
  out.emit(() => ["discovery is not finished; still missing:", ...check.missing.map((m) => `  ${m}`), "run `slate discover` to continue the conversation"], { done: false, missing: check.missing })
  return 1
}

const ANTHROPIC_MODELS = { low: "claude-haiku-4-5-20251001", medium: "claude-sonnet-5", high: "claude-opus-5-5" }

type TierModels = { low: string; medium: string; high: string }

/**
 * Provider and per-tier models. Interactively, the choices come from what the user's OpenCode has
 * connected, so nothing is typed; flags fill in or skip any of it. Without a TTY (or if OpenCode
 * cannot be read) it falls back to flags and Anthropic defaults.
 */
async function chooseModels(interactive: boolean, given: { provider?: string } & Partial<TierModels>): Promise<{ provider: string; models: TierModels; fromCatalog: boolean }> {
  const tiers = ["low", "medium", "high"] as const
  const complete = given.provider && tiers.every((t) => given[t])
  if (interactive && !complete) {
    const catalog = await spin("reading connected providers from OpenCode…", loadCatalog()).catch((e: Error) => {
      process.stderr.write(`could not read providers from OpenCode (${e.message.split("\n")[0]}); type them instead\n`)
      return undefined
    })
    if (catalog) {
      if (!catalog.providers.length) throw new CliError("no model provider is connected in OpenCode", "connect one in OpenCode (log in, or set its API key env var such as ANTHROPIC_API_KEY), then re-run `slate init`")
      const count = (id: string) => catalog.models.filter((m) => m.providerID === id).length
      let provider = given.provider
      if (!provider && catalog.providers.length === 1) answered("provider", (provider = catalog.providers[0]!.id))
      provider ??= await select(
        "provider",
        catalog.providers.map((p) => ({ value: p.id, label: p.name === p.id ? p.id : `${p.name} (${p.id})`, hint: `${count(p.id)} models` })),
        catalog.providers.find((p) => p.id === "anthropic")?.id,
      )
      const available = catalog.models.filter((m) => m.providerID === provider)
      if (!available.length) throw new CliError(`provider '${provider}' has no usable models in OpenCode`, `connected: ${catalog.providers.map((p) => p.id).join(", ")}`)
      const defs = defaultTiers(available, ANTHROPIC_MODELS)
      const price = (m: CatalogModel) => (m.cost ? m.cost.input + m.cost.output : Infinity)
      const choices = [...available].sort((a, b) => price(a) - price(b) || a.name.localeCompare(b.name)).map((m) => ({ value: m.id, label: m.id, hint: modelHint(m) }))
      const models = {} as TierModels
      for (const t of tiers) models[t] = given[t] ?? (await select(`model for ${t} tier`, choices, defs[t]))
      return { provider, models, fromCatalog: true }
    }
  }
  const provider = given.provider ?? (interactive ? await input("provider id (as OpenCode names it)", { def: "anthropic" }) : "anthropic")
  const defaults = provider === "anthropic" ? ANTHROPIC_MODELS : undefined
  const models = {} as TierModels
  for (const t of tiers) {
    const m = given[t] ?? (interactive ? await input(`model for ${t} tier`, { def: defaults?.[t] }) : defaults?.[t])
    if (!m) throw new CliError(`no default models for provider '${provider}'`, "pass --low, --medium and --high")
    models[t] = m
  }
  return { provider, models, fromCatalog: false }
}

/** A budget cap for display; unset or 0 means no cap. */
function cap(n: number | undefined): string {
  return n ? usd(n) : "no cap"
}

/** "$3/$15 per Mtok · 200k ctx" */
function modelHint(m: CatalogModel): string {
  const parts: string[] = []
  if (m.name !== m.id) parts.push(m.name)
  if (m.cost) parts.push(m.cost.input + m.cost.output === 0 ? "free" : `$${m.cost.input}/$${m.cost.output} per Mtok`)
  if (m.context) parts.push(m.context >= 1_000_000 ? `${+(m.context / 1_000_000).toFixed(1)}M ctx` : `${Math.round(m.context / 1000)}k ctx`)
  return parts.join(" · ")
}

const AUTONOMY = [
  { value: "supervised", hint: "you approve gates; questions wait up to 8h" },
  { value: "unattended", hint: "approvals take the default; questions time out after 1h" },
] as const

/* --------------------------------------------------------------------- start */

register(
  "start",
  `slate start [--autonomy supervised|unattended | --yes] [--detach] [--quiet]
            [--dry-run [--idea "text" | --brief FILE] [--pack name[@version]]]
Starts a job from a finished discovery (\`slate discover\`): plan (approval), build, close.
  --autonomy supervised   runs here; you answer approvals and questions as they come (the default)
  --autonomy unattended   approvals take their default and the job runs in the background
  --yes                   same as --autonomy unattended
  --detach                run a supervised job in the background too; answer with \`slate inbox\`
  --dry-run               fake runtime, no model calls; may skip discovery and start from --idea or --brief
Asks for the autonomy when it is not given and there is a terminal. Fails when a job is already open.`,
  async (argv, out) => {
    const { flags } = parseArgs(["start", ...argv])
    const p = await requireProject()
    const interactive = process.stdin.isTTY && !out.json
    const dryRun = bool(flags, "dry-run")
    const opts: RunOptions = { dryRun, autoApprove: false, quiet: bool(flags, "quiet", "q") }

    // Discovery must be finished (and not used by an earlier job) before anything runs.
    let record = await readDiscovery(p.paths)
    let check = record.job ? { done: false, missing: ["a new discovery (the last one was used by job " + record.job + ")"] } : await checkDiscovery(p.paths)
    if (!check.done && dryRun && (str(flags, "idea") || str(flags, "brief") || (!record.job && (await isFile(p.paths.brief))))) {
      // Dry runs can still exercise intake from an idea or a brief.
      Object.assign(opts, { idea: str(flags, "idea"), briefPath: str(flags, "brief"), packRef: str(flags, "pack") })
    } else if (!check.done) {
      const open = interactive && (await select("discovery isn't finished. Open it in OpenCode now?", [{ value: "yes" }, { value: "no" }], "yes")) === "yes"
      if (open) check = await runDiscovery(p.paths, p.config, { fresh: !!record.job })
      if (!check.done) throw new CliError(`discovery isn't finished; missing: ${check.missing.join(", ")}`, "run `slate discover`, then `slate start`")
      record = await readDiscovery(p.paths)
    }

    const autonomyFlag = bool(flags, "yes", "y") ? "unattended" : str(flags, "autonomy")
    if (autonomyFlag && autonomyFlag !== "supervised" && autonomyFlag !== "unattended") throw new CliError(`--autonomy must be supervised or unattended, not '${autonomyFlag}'`)
    const autonomy = autonomyFlag ?? (interactive ? await select("autonomy", AUTONOMY, "supervised") : "supervised")
    opts.autoApprove = autonomy === "unattended"

    const store = await createJob(p, { ...opts, discovered: check.done ? check.pack : undefined })
    const jobId = store.get().job.id
    if (check.done) await writeDiscovery(p.paths, { ...record, job: jobId })
    if (opts.autoApprove || bool(flags, "detach")) {
      const pid = await runDetached(p, opts)
      out.emit(() => [`job ${jobId} started in the background (${autonomy}, pid ${pid})`, `  slate status   to see progress`, `  slate inbox    to answer questions`, `  slate continue to attach`], { job: jobId, pid, detached: true, autonomy })
      return 0
    }
    const state = await runForeground(p, store, opts, out)
    out.emit(() => summary(state), { job: state.job, status: state.status, phase: state.phase, reason: state.stopReason, spend: state.spend.total })
    return state.status === "failed" ? 1 : 0
  },
)

/** Internal: the detached engine process entry. */
register("_run", "internal", async (argv, out) => {
  const { flags } = parseArgs(["_run", ...argv])
  const p = await requireProject()
  const store = await StateStore.open(p.paths.state)
  if (!store) throw new CliError("no job to run")
  const state = await runForeground(p, store, { dryRun: bool(flags, "dry-run"), autoApprove: bool(flags, "yes"), quiet: false }, out)
  return state.status === "failed" ? 1 : 0
})

/* ------------------------------------------------------------------ continue */

register(
  "continue",
  `slate continue [--yes] [--detach] [--quiet]
Reattaches to the current job. If an engine process is running, streams its log and status until it finishes or you press Ctrl-C
(the job keeps running). If the job is stopped, blocked or was interrupted, resumes it from state.json: here for a
supervised job, in the background (and watched from here) for an unattended one. Questions are asked inline with a picker.
Fails when no job exists.`,
  async (argv, out) => {
    const { flags } = parseArgs(["continue", ...argv])
    const p = await requireJob()
    const pid = await isEngineAlive(p.paths)
    if (pid) return attach(p.paths, pid, out)
    const store = await StateStore.open(p.paths.state)
    if (!store) throw new CliError("no job exists", "run `slate start`")
    const st = store.get()
    if (st.status === "done") {
      out.emit(() => [`job ${st.job.id} is already done`, ...summary(st)], { job: st.job, status: st.status })
      return 0
    }
    const unattended = bool(flags, "yes", "y") || st.job.autonomy === "unattended"
    const opts: RunOptions = { dryRun: st.job.runtime === "fake", autoApprove: unattended, quiet: bool(flags, "quiet", "q") }
    if (unattended && !bool(flags, "detach") && process.stdin.isTTY && !out.json) {
      // An unattended job keeps running in the background; this terminal only watches it.
      const newPid = await runDetached(p, opts)
      out.line(`resumed ${st.job.id} in the background (unattended, pid ${newPid})`)
      return attach(p.paths, newPid, out)
    }
    if (bool(flags, "detach")) {
      const newPid = await runDetached(p, opts)
      out.emit(() => [`resumed ${st.job.id} in the background (pid ${newPid})`], { job: st.job.id, pid: newPid })
      return 0
    }
    out.line(`resuming ${st.job.id} from phase ${st.phase} (${st.status}${st.stopReason ? `: ${st.stopReason}` : ""})`)
    const state = await runForeground(p, store, opts, out)
    out.emit(() => summary(state), { job: state.job, status: state.status, phase: state.phase, reason: state.stopReason })
    return state.status === "failed" ? 1 : 0
  },
)

async function attach(paths: ReturnType<typeof projectPaths>, pid: number, out: Output): Promise<number> {
  out.line(`attached to engine pid ${pid}; Ctrl-C detaches (the job keeps running)`)
  let seen = (await AuditLog.read(paths.log)).length
  let detached = false
  const stopAsking = process.stdin.isTTY && !out.json ? answerInline(paths) : undefined
  process.once("SIGINT", () => {
    detached = true
  })
  while (!detached) {
    const records = await AuditLog.read(paths.log)
    for (const r of records.slice(seen)) if (!out.json) logLine(formatAudit(r.at, r.event))
    seen = records.length
    const alive = await isEngineAlive(paths)
    if (!alive) {
      stopAsking?.()
      const st = await StateStore.read(paths.state)
      if (st) out.emit(() => summary(st), { job: st.job, status: st.status, phase: st.phase })
      return 0
    }
    await sleep(1000)
  }
  stopAsking?.()
  out.line("detached")
  return 0
}

async function readActivity(file: string): Promise<ActivityFile | undefined> {
  try {
    return JSON.parse(await readTextOr(file, "")) as ActivityFile
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------- status */

register(
  "status",
  `slate status [--json]
Where the job is and what to do next, questions waiting on you (oldest first), what each branch is doing, what each
running agent is doing right now (consults and subagents indented under the agent that started them, with the
\`slate log\` target for each), tokens and spend per model, task and story, and steps that failed their output
contract. Fails when there is no project.`,
  async (_argv, out) => {
    const p = await requireProject()
    const st = await StateStore.read(p.paths.state)
    if (!st) {
      out.emit(() => ["no job yet", "  run `slate start` to begin one"], { job: null })
      return 0
    }
    const pid = await isEngineAlive(p.paths)
    const open = st.questions.filter((q) => !q.answered).sort((a, b) => a.created.localeCompare(b.created))
    const running = Object.values(st.steps).filter((s) => s.status === "running")
    const branches = Object.values(st.branches).filter((b) => b.id !== "main" || Object.keys(st.branches).length === 1)
    const failures = st.contractFailures
    const lines: string[] = []
    lines.push(`${st.job.name} (${st.job.id}) · phase ${st.phase} · ${describeStatus(st, pid ?? null)}`)
    if (st.job.pack) lines.push(`pack ${st.job.pack.name}@${st.job.pack.version} · opencode ${st.job.opencode} · runtime ${st.job.runtime}`)
    if (st.stopReason) lines.push(`  ${st.stopReason}`)
    const next = nextAction(st, pid ?? null)
    if (next) lines.push(`next: ${next}`)
    lines.push("")
    lines.push(`waiting on you: ${open.length}${open.length ? " (answer with: slate inbox)" : ""}`)
    for (const q of open) lines.push(`  [${q.id}] ${ageOf(q.created)} ago  ${q.kind}  ${q.branch}: ${q.prompt.slice(0, 120)}`)
    lines.push("")
    lines.push("branches:")
    if (!branches.length) lines.push("  (none yet)")
    for (const b of branches) lines.push(`  ${b.id.padEnd(28)} ${b.status.padEnd(8)} ${b.current ? `at ${b.current}` : ""}${b.blockedOn ? ` waiting on ${b.blockedOn}` : ""}  (${ageOf(b.since)})`)
    if (running.length) lines.push(`running steps: ${running.map((r) => r.key).join(", ")}`)
    // What each agent is doing right now; only meaningful while an engine is running.
    const activity = pid ? await readActivity(p.paths.activity) : undefined
    const agents = activity ? activityLines(activity, ageOf) : []
    if (agents.length) lines.push("", "agents:", ...agents)
    lines.push("")
    lines.push(`spend: ${usd(st.spend.total)} of ${cap(p.config.budget.job)}   tokens in/out ${st.spend.tokens.input}/${st.spend.tokens.output}`)
    const byModel = Object.entries(st.spend.byModel).sort((a, b) => b[1] - a[1])
    if (byModel.length) lines.push(...table(byModel.map(([m, c]) => [m, usd(c)]), { header: ["model", "spend"], indent: "  " }))
    const byStory = Object.entries(st.spend.byStory).sort((a, b) => b[1] - a[1])
    if (byStory.length) lines.push(...table(byStory.map(([m, c]) => [m, usd(c)]), { header: ["story", "spend"], indent: "  " }))
    const byTask = Object.entries(st.spend.byTask).sort((a, b) => b[1] - a[1]).slice(0, 15)
    if (byTask.length) lines.push(...table(byTask.map(([m, c]) => [m, `${usd(c)} / ${cap(p.config.budget.per_task)}`]), { header: ["task", "spend / cap"], indent: "  " }))
    lines.push("")
    lines.push(`contract failures: ${failures.length} (${failures.filter((f) => f.retried).length} re-prompted)`)
    for (const f of failures.slice(-8)) lines.push(`  ${f.key}: missing ${f.missing.join(", ") || "(bad verdict)"}${f.retried ? " -> re-prompted" : ""}`)
    out.emit(() => lines, { job: st.job, phase: st.phase, status: st.status, reason: st.stopReason, enginePid: pid ?? null, questions: open, branches: st.branches, running: running.map((r) => r.key), agents: activity ? Object.values(activity.sessions).filter((a) => !a.done) : [], spend: st.spend, budget: p.config.budget, contractFailures: failures })
    return 0
  },
)

/* --------------------------------------------------------------------- inbox */

register(
  "inbox",
  `slate inbox [--answer QID OPTION [--message TEXT]] [--json]
Walks through open questions one at a time with the context re-shown, including reviewer notes from gates; pick an answer.
Non-interactive: \`slate inbox --answer <qid> <option> [--message "..."]\`. Works without attaching. Fails when no job exists.`,
  async (argv, out) => {
    const { flags, positional } = parseArgs(["inbox", ...argv])
    const p = await requireJob()
    const open = p.state.questions.filter((q) => !q.answered).sort((a, b) => a.created.localeCompare(b.created))
    // Questions only live as long as the engine that asked them; a resumed job asks again.
    if (open.length && !(await isEngineAlive(p.paths))) {
      throw new CliError(`no engine is running, so the ${open.length} open question${open.length === 1 ? "" : "s"} cannot be answered`, "run `slate continue`; the job asks them again")
    }
    const answerFlag = str(flags, "answer")
    if (answerFlag) {
      const option = positional[0] ?? str(flags, "option")
      if (!option) throw new CliError("--answer needs the option to answer with", "slate inbox --answer <qid> <option> [--message TEXT]")
      const q = open.find((x) => x.id === answerFlag)
      if (!q) throw new CliError(`no open question ${answerFlag}`, "run `slate inbox` to list them")
      if (!isValidAnswer(q, option)) throw new CliError(`'${option}' is not one of: ${q.options.map((o) => o.id).join(", ")}`, q.freeText ? 'add a note with --message "..."' : undefined)
      await deliverAnswer(p.paths, q, option, str(flags, "message"))
      out.emit(() => [`answered ${q.id}: ${option}`], { id: q.id, answer: option })
      return 0
    }
    if (!open.length) {
      out.emit(() => ["inbox is empty"], { questions: [] })
      return 0
    }
    if (out.json || !process.stdin.isTTY) {
      out.emit(() => open.map((q) => formatQuestion(q)).flat(), { questions: open })
      return 0
    }
    for (const [i, q] of open.entries()) {
      out.line(`\n(${i + 1}/${open.length}) ${formatQuestion(q).join("\n")}`)
      const picked = await pickAnswer(q, { quit: true })
      if (picked === "quit") break
      if (picked === "skip") continue
      await deliverAnswer(p.paths, q, picked.answer, picked.message)
      out.line(`  answered: ${picked.answer}`)
    }
    return 0
  },
)


function formatQuestion(q: Question): string[] {
  const lines = [`[${q.id}] ${q.kind} · ${ageOf(q.created)} ago · pauses ${q.branch}${q.step ? ` · step ${q.step}` : ""}`, `  ${q.prompt}`]
  for (const c of q.context) if (c !== "ESCALATED") lines.push(...c.split("\n").slice(0, 25).map((l) => `    ${l}`))
  if (q.reviewerNotes?.length) lines.push(`  reviewer notes:`, ...q.reviewerNotes.map((n) => `    - ${n}`))
  if (q.options.length) lines.push(`  options: ${q.options.map((o) => `${o.id}${o.default ? " (default)" : ""}`).join(" | ")}`)
  return lines
}

/* ----------------------------------------------------------------------- log */

register(
  "log",
  `slate log [<task|story|step>] [--tail N] [--json]
Decisions and reasoning per task: consults, verdicts, gate outcomes, retries, loop rounds. Fails when there is no project.`,
  async (argv, out) => {
    const { flags, positional } = parseArgs(["log", ...argv])
    const p = await requireProject()
    const records = await AuditLog.read(p.paths.log)
    if (!records.length) {
      out.emit(() => ["no history yet"], { records: [] })
      return 0
    }
    const filter = positional[0]
    const tail = num(flags, "tail")
    let selected = records.filter((r) => {
      const t = r.event.type
      if (!["consult", "verdict", "gate", "infra.retry", "contract.failed", "loop.round", "loop.exhausted", "question.open", "question.answered", "step.end", "budget", "job", "plan.revise", "loop.iteration"].includes(t)) return false
      if (!filter) return true
      const s = JSON.stringify(r.event)
      return s.includes(`"${filter}"`) || s.includes(`/${filter}`) || s.includes(`:${filter}`) || s.includes(`${filter}/`) || s.includes(filter)
    })
    if (tail) selected = selected.slice(-tail)
    out.emit(() => selected.map((r) => formatAudit(r.at, r.event)), { records: selected })
    return 0
  },
)

function formatAudit(at: string, e: import("../../engine/types.ts").AuditEvent): string {
  const t = at.slice(11, 19)
  switch (e.type) {
    case "step.start":
      return `${t}  start   ${e.key}${e.agent ? ` (${e.agent})` : ""}`
    case "step.end":
      return `${t}  ${e.status.padEnd(7)} ${e.key}${e.cost !== undefined ? ` ${usd(e.cost)}` : ""}${e.reason ? ` — ${e.reason}` : ""}`
    case "verdict":
      return `${t}  verdict ${e.key}: ${e.verdict} (${e.file})`
    case "consult":
      return `${t}  consult ${e.key} asked ${e.consultant} #${e.n}: verdict ${e.verdict} -> ${e.file}`
    case "gate":
      return `${t}  gate    ${e.key}: ${e.action} ${e.resource} -> ${e.decision}${e.reviewers.length ? ` [${e.reviewers.map((r) => `${r.id}:${r.decision}`).join(", ")}]` : ""}`
    case "infra.retry":
      return `${t}  retry   ${e.key} attempt ${e.attempt}: ${e.error}`
    case "contract.failed":
      return `${t}  contract ${e.key}: ${e.reason}${e.reprompt ? " (re-prompting)" : ""}`
    case "loop.exhausted":
      return `${t}  out of rounds ${e.key} -> ${e.policy}`
    case "loop.iteration":
      return `${t}  iterate ${e.key} #${e.iteration + 1} = ${e.value}`
    case "loop.round":
      return `${t}  round   ${e.key} ${e.round}/${e.max}`
    case "question.open":
      return `${t}  ask     [${e.id}] ${e.kind} (${e.branch}): ${e.prompt.slice(0, 100)}`
    case "question.answered":
      return `${t}  answer  [${e.id}] ${e.answer}${e.message ? ` — ${e.message}` : ""}`
    case "budget":
      return `${t}  budget  ${e.scope}: ${usd(e.spent)} of ${usd(e.cap)} -> stopped`
    case "job":
      return `${t}  job     ${e.status}${e.phase ? ` ${e.phase}` : ""}${e.reason ? ` — ${e.reason}` : ""}`
    case "plan.revise":
      return `${t}  plan    revise: ${e.note}`
    case "script":
      return `${t}  script  ${e.key} ${e.script} ${e.ok ? "ok" : `BROKEN ${e.error}`}`
    case "worktree":
      return `${t}  worktree ${e.action} ${e.directory}`
    case "session":
      return `${t}  session ${e.key} ${e.sessionID} ${e.agent} ${e.model}`
    default:
      return `${t}  ${(e as { type: string }).type}`
  }
}

/* ---------------------------------------------------------------------- plan */

register(
  "plan",
  `slate plan [revise "note"] [--json]
Views the approved plan (stories/index.yaml and stories/graph.yaml). \`slate plan revise "note"\` asks the engine to re-run the
plan steps with your note at the next story boundary and re-queue affected stories. Fails when no plan is approved yet.`,
  async (argv, out) => {
    const { positional } = parseArgs(["plan", ...argv])
    const p = await requireJob()
    const approved = Object.values(p.state.steps).some((s) => s.type === "approval" && s.status === "passed" && s.key.startsWith("plan/"))
    const indexPath = path.join(p.root, "stories", "index.yaml")
    const graphPath = path.join(p.root, "stories", "graph.yaml")
    if (!approved && !(await isFile(indexPath))) throw new CliError("no plan approved yet", "run `slate continue` and answer the approval in `slate inbox`")
    if (positional[0] === "revise") {
      const note = positional.slice(1).join(" ")
      if (!note) throw new CliError("give the revision note", 'slate plan revise "split story 3 into two"')
      await ensureDir(p.paths.control)
      await writeJsonAtomic(path.join(p.paths.control, "revise.json"), { note, at: new Date().toISOString() })
      out.emit(() => [`revision queued: ${note}`, "  the engine re-runs the plan steps at the next story boundary"], { queued: true, note })
      return 0
    }
    const index = await readTextOr(indexPath, "(no stories/index.yaml)")
    const graph = await readTextOr(graphPath, "(no stories/graph.yaml)")
    const merged = Object.values(p.state.loops).flatMap((l) => l.iterations ?? []).map((i) => `${i.value}: ${i.status}`)
    out.emit(() => ["# stories/index.yaml", index.trim(), "", "# stories/graph.yaml", graph.trim(), "", `# progress`, ...(merged.length ? merged.map((m) => `  ${m}`) : ["  (no stories started)"]), `# revisions: ${p.state.planRevisions}`], { index: safeYaml(index), graph: safeYaml(graph), progress: merged, revisions: p.state.planRevisions })
    return 0
  },
)

function safeYaml(text: string): unknown {
  try {
    return YAML.parse(text)
  } catch {
    return text
  }
}

/* ---------------------------------------------------------------------- pack */

register(
  "pack",
  `slate pack list | add <dir> [--project] | update <name[@version]> | validate <dir>
Validation checks the manifest, agent, skill and script schemas and every id reference.`,
  async (argv, out) => {
    const { positional, flags } = parseArgs(["pack", ...argv])
    const sub = positional[0]
    const root = (await loadProjectConfig(process.cwd())) ? process.cwd() : undefined
    switch (sub) {
      case "list":
      case undefined: {
        const packs = await listInstalledPacks(root)
        out.emit(() => (packs.length ? table(packs.map((p) => [`${p.name}@${p.version}`, p.source, p.fits || p.description]), { header: ["pack", "source", "fits"] }) : ["no packs installed", "  slate pack add <dir>"]), { packs })
        return 0
      }
      case "add": {
        const dir = positional[1]
        if (!dir) throw new CliError("give the pack directory", "slate pack add ./my-pack")
        const installed = await addPack(dir, { root, scope: bool(flags, "project") ? "project" : "user" })
        out.emit(() => [`installed ${installed.name}@${installed.version} -> ${installed.dir}`], { installed })
        return 0
      }
      case "update": {
        const ref = positional[1]
        if (!ref) throw new CliError("give the pack name", "slate pack update my-pack")
        const updated = await updatePack(ref, { root })
        out.emit(() => [`updated ${updated.name}@${updated.version} from ${updated.origin}`], { updated })
        return 0
      }
      case "validate": {
        const dir = positional[1] ?? "."
        const r = await validatePackDir(dir)
        if (r.ok) {
          const m = r.pack.manifest
          out.emit(() => [`ok: ${m.name}@${m.version}`, `  agents: ${Object.keys(r.pack.agents).join(", ")}`, `  skills: ${Object.keys(r.pack.skills).join(", ")}`, `  scripts: ${Object.keys(r.pack.scripts).join(", ")}`], { ok: true, name: m.name, version: m.version, agents: Object.keys(r.pack.agents), skills: Object.keys(r.pack.skills), scripts: Object.keys(r.pack.scripts) })
          return 0
        }
        out.emit(() => [`invalid pack (${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}):`, ...r.problems.map((x) => `  - ${x}`)], { ok: false, problems: r.problems })
        return 1
      }
      default:
        throw new CliError(`unknown pack subcommand '${sub}'`, "slate pack list | add | update | validate")
    }
  },
)

/* ---------------------------------------------------------------------- stop */

register(
  "stop",
  `slate stop [--now]
Finishes the current step, checkpoints, halts. --now interrupts in-flight sessions and discards the partial step.
Says so when the job is already stopped.`,
  async (argv, out) => {
    const { flags } = parseArgs(["stop", ...argv])
    const p = await requireJob()
    const pid = await isEngineAlive(p.paths)
    if (!pid) {
      const st = p.state
      if (st.status === "running" || st.status === "blocked") {
        // Engine died without checkpointing status; mark it so continue knows.
        const store = await StateStore.open(p.paths.state)
        await store?.update((s) => {
          s.status = "stopped"
          s.stopReason = "no engine process was running"
        })
      }
      out.emit(() => [`job ${st.job.id} is already stopped (${st.status})`], { job: st.job.id, status: st.status, alreadyStopped: true })
      return 0
    }
    await ensureDir(p.paths.control)
    await writeText(path.join(p.paths.control, bool(flags, "now") ? "stop-now" : "stop"), new Date().toISOString())
    out.emit(() => [bool(flags, "now") ? `interrupting engine pid ${pid}; the partial step is discarded` : `engine pid ${pid} will stop after the current step`], { job: p.state.job.id, pid, now: bool(flags, "now") })
    return 0
  },
)

/* ------------------------------------------------------------------- helpers */

function summary(st: JobState): string[] {
  const lines = [`job ${st.job.id}: ${describeStatus(st)} · phase ${st.phase} · spend ${usd(st.spend.total)}`]
  if (st.stopReason) lines.push(`  ${st.stopReason}`)
  const passed = Object.values(st.steps).filter((s) => s.status === "passed").length
  const failed = Object.values(st.steps).filter((s) => s.status === "failed").length
  lines.push(`steps passed ${passed} · failed ${failed} · contract failures ${st.contractFailures.length}`)
  const next = nextAction(st)
  if (next) lines.push(`next: ${next}`)
  return lines
}

/** The job's status in words. `pid` is passed when the caller knows whether an engine process is alive. */
function describeStatus(st: JobState, pid?: number | null): string {
  const open = st.questions.filter((q) => !q.answered).length
  const engine = pid === undefined ? "" : pid ? ` (engine pid ${pid})` : " (no engine process)"
  switch (st.status) {
    case "running":
      return `running${open ? `, ${open} question${open === 1 ? "" : "s"} waiting` : ""}${engine}`
    case "blocked":
      return `waiting on you: nothing can move until you answer${engine}`
    default:
      return `${st.status}${engine}`
  }
}

/** One line telling a human what to do now, or undefined when nothing is needed. */
function nextAction(st: JobState, pid?: number | null): string | undefined {
  const open = st.questions.some((q) => !q.answered)
  if (st.status === "done") return undefined
  if ((st.status === "running" || st.status === "blocked") && pid === null) return "the engine is not running; slate continue resumes the job"
  if (open) return "slate inbox"
  if (st.status === "stopped") return "slate continue"
  if (st.status === "failed") return "fix what failed (see above and slate log), then slate continue re-runs it"
  return undefined
}

export { formatAudit, removePath }
