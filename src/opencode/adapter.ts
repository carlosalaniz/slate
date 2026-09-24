import path from "node:path"
import type {
  Runtime,
  JobContext,
  RunStepRequest,
  RunStepResult,
  RepromptRequest,
  ReviewRequest,
  QuestionReply,
  WorktreeRequest,
  ModelRef,
  TokenUsage,
  RuntimeQuestion,
} from "../engine/types.ts"
import { EMPTY_TOKENS } from "../engine/types.ts"
import { ensureDir, copyDir, removePath, isDir } from "../util/fs.ts"
import { SessionRegistry } from "./registry.ts"
import { createSlatePlugin, lastAssistantText } from "./plugin.ts"

/**
 * The one module that talks to `@opencode/sdk`. Everything OpenCode-specific (call shapes, event
 * names, the lazy plugin setup) is contained here so a v2 API change touches one file.
 *
 * Facts this adapter relies on (verified against @opencode/sdk 2.0.15):
 *  - `OpenCode.create` embeds the host in memory; plugin `setup` runs lazily per location the first
 *    time a capability-reading call (permission list, prompt) touches that location.
 *  - `session.create` accepts `agent`, `model`, `location.directory`, `metadata` and per-session
 *    `permissions` rules. `session.wait` resolves when the session goes idle.
 *  - `session.get` returns `cost`, `tokens` and `outcome` directly.
 *  - `generate.text` is a transient generation with no session.
 */
export interface OpenCodeRuntimeOptions {
  log?: (line: string) => void
  logLevel?: "trace" | "debug" | "info" | "warn" | "error"
  worktreeStrategy?: "git" | "copy" | "none"
}

export class OpenCodeRuntime implements Runtime {
  readonly kind = "opencode" as const
  private oc: any
  private job!: JobContext
  private readonly registry = new SessionRegistry()
  private eventAbort = new AbortController()
  private usage = new Map<string, { cost: number; tokens: TokenUsage }>()
  private sdkVersion = "unknown"
  private warmed = new Set<string>()

  constructor(private readonly opts: OpenCodeRuntimeOptions = {}) {}

  version(): string {
    return this.sdkVersion
  }

  private log(line: string) {
    this.opts.log?.(line)
  }

  async start(job: JobContext): Promise<void> {
    this.job = job
    await ensureDir(path.dirname(job.dbPath))
    await ensureDir(job.consultsDir)
    const sdk = await import("@opencode/sdk")
    try {
      const entry = Bun.resolveSync("@opencode/sdk", import.meta.dir)
      const pkg = await Bun.file(path.resolve(path.dirname(entry), "..", "package.json")).json()
      this.sdkVersion = String(pkg.version ?? "unknown")
    } catch {
      this.sdkVersion = "2.x"
    }
    const plugin = createSlatePlugin({ job, registry: this.registry, tier: (t) => job.tier(t), log: (l) => this.log(l) })
    this.oc = await sdk.OpenCode.create({
      database: { path: job.dbPath },
      plugins: [plugin as any],
      log: {
        level: this.opts.logLevel ?? "warn",
        emit: (e: any) => {
          if (e.level === "error" || e.level === "fatal") this.log(`[opencode] ${e.message} ${e.cause ? String(e.cause).split("\n")[0] : ""}`)
        },
      },
    })
    void this.pumpEvents()
    await this.warm(job.root)
  }

  /**
   * Plugin setup runs lazily per location and its transforms apply asynchronously. Before the first
   * session in a directory, trigger setup and wait until Slate's agents are in the catalog.
   */
  private async warm(directory: string): Promise<void> {
    if (this.warmed.has(directory)) return
    const want = Object.values(this.job.pack.agents).filter((a) => a.role !== "reviewer").map((a) => a.id)
    want.push(...Object.values(this.job.core.agents).filter((a) => a.role !== "reviewer").map((a) => a.id))
    let probe: string | undefined
    try {
      const s = await this.oc.sessions.create({ location: { directory }, title: "slate warm-up" })
      probe = s.id
      await this.oc.permission.list({ sessionID: s.id })
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const agents: string[] = ((await this.oc.agent.list({ location: { directory } })).data ?? []).map((a: any) => a.id)
        if (want.every((id) => agents.includes(id))) break
        await new Promise((r) => setTimeout(r, 150))
      }
      const agents: string[] = ((await this.oc.agent.list({ location: { directory } })).data ?? []).map((a: any) => a.id)
      const missing = want.filter((id) => !agents.includes(id))
      if (missing.length) this.log(`[opencode] agents not registered for ${directory}: ${missing.join(", ")}`)
    } finally {
      if (probe) await this.oc.sessions.remove({ sessionID: probe }).catch(() => undefined)
      this.warmed.add(directory)
    }
  }

  private async pumpEvents(): Promise<void> {
    try {
      for await (const ev of this.oc.events.subscribe({ signal: this.eventAbort.signal })) {
        this.handleEvent(ev)
      }
    } catch {
      /* closed */
    }
  }

  private handleEvent(ev: any): void {
    const sessionID: string | undefined = ev?.data?.sessionID ?? ev?.data?.form?.sessionID
    if (!sessionID) return
    const entry = this.registry.get(sessionID)
    if (ev.type === "session.usage.updated") {
      this.usage.set(sessionID, { cost: ev.data.cost ?? 0, tokens: ev.data.tokens ?? EMPTY_TOKENS })
      return
    }
    if (!entry) return
    const owner = entry.parent ? this.registry.get(entry.parent) : entry
    if (ev.type === "permission.asked") {
      const q: RuntimeQuestion = {
        kind: "permission",
        sessionID,
        requestID: ev.data.id,
        action: ev.data.action,
        resources: ev.data.resources,
        message: ev.data.message,
        reviewerNotes: entry.reviewerNotes.length ? [...entry.reviewerNotes] : undefined,
      }
      entry.reviewerNotes = []
      owner?.onQuestion?.(q)
    } else if (ev.type === "form.created") {
      const form = ev.data.form
      owner?.onQuestion?.({ kind: "form", sessionID, requestID: form.id, title: form.title, fields: form.fields, message: form.title })
    }
  }

  async close(): Promise<void> {
    this.eventAbort.abort()
    try {
      await this.oc?.close()
    } catch {
      /* ignore */
    }
  }

  async models(): Promise<{ providers: string[]; models: string[] }> {
    const loc = { location: { directory: this.job.root } }
    try {
      // Listing needs a session to exist for the location; create a throwaway one.
      const s = await this.oc.sessions.create({ location: { directory: this.job.root }, title: "slate probe" })
      await this.oc.permission.list({ sessionID: s.id }).catch(() => undefined)
      const providers = await this.oc.provider.list(loc)
      const models = await this.oc.model.list(loc)
      await this.oc.sessions.remove({ sessionID: s.id }).catch(() => undefined)
      return {
        providers: (providers.data ?? []).map((p: any) => p.id),
        models: (models.data ?? []).map((m: any) => `${m.providerID ?? m.provider?.id ?? "?"}/${m.id}`),
      }
    } catch (e) {
      this.log(`[opencode] model listing failed: ${(e as Error).message}`)
      return { providers: [], models: [] }
    }
  }

  async runStep(req: RunStepRequest): Promise<RunStepResult> {
    await this.warm(req.directory)
    const session = await this.oc.sessions.create({
      location: { directory: req.directory },
      agent: req.agent.id,
      model: req.model,
      title: req.title,
      metadata: { slateJob: this.job.jobId, slateStep: req.stepId, slateKey: req.key, slatePhase: req.phase },
      permissions: req.permissions,
    })
    const sessionID: string = session.id
    this.registry.set({
      sessionID,
      key: req.key,
      stepId: req.stepId,
      phase: req.phase,
      agent: req.agent,
      directory: req.directory,
      vars: req.vars,
      consult: req.consult,
      consultsMade: 0,
      children: [],
      gates: req.gates,
      role: "worker",
      reviewerNotes: [],
      onAudit: req.onAudit,
      onQuestion: req.onQuestion,
    })
    req.onAudit?.({ type: "session", key: req.key, sessionID, agent: req.agent.id, model: `${req.model.providerID}/${req.model.id}`, directory: req.directory })
    try {
      await this.oc.sessions.prompt({
        sessionID,
        text: req.prompt,
        files: req.files.map((f) => ({ uri: "file://" + f })),
      })
      const outcome = await this.waitFor(sessionID, req.timeoutMs, req.signal)
      return await this.collect(sessionID, req.model, outcome)
    } finally {
      /* keep the registry entry until the step's follow-ups are done; reprompt reuses it */
    }
  }

  async reprompt(req: RepromptRequest): Promise<RunStepResult> {
    const entry = this.registry.get(req.sessionID)
    await this.oc.sessions.prompt({ sessionID: req.sessionID, text: req.text })
    const outcome = await this.waitFor(req.sessionID, req.timeoutMs)
    const info = await this.oc.sessions.get({ sessionID: req.sessionID })
    return this.collect(req.sessionID, info.model ?? { providerID: "?", id: "?" }, outcome, entry?.children ?? [])
  }

  private async waitFor(sessionID: string, timeoutMs: number, signal?: AbortSignal): Promise<RunStepResult["outcome"]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    const aborted = new Promise<"interrupted">((resolve) => signal?.addEventListener("abort", () => resolve("interrupted"), { once: true }))
    const waited = this.oc.sessions.wait({ sessionID }).then(() => "done" as const, () => "done" as const)
    const result = await Promise.race([waited, timeout, aborted])
    if (timer) clearTimeout(timer)
    if (result === "timeout" || result === "interrupted") {
      await this.interrupt(sessionID)
      return result
    }
    const info = await this.oc.sessions.get({ sessionID })
    return (info.outcome as RunStepResult["outcome"] | undefined) ?? "succeeded"
  }

  private async collect(sessionID: string, model: ModelRef, outcome: RunStepResult["outcome"], children?: string[]): Promise<RunStepResult> {
    const info = await this.oc.sessions.get({ sessionID })
    const entry = this.registry.get(sessionID)
    let cost = Number(info.cost ?? 0)
    const tokens: TokenUsage = info.tokens ?? { ...EMPTY_TOKENS, cache: { read: 0, write: 0 } }
    for (const child of children ?? entry?.children ?? []) {
      try {
        const c = await this.oc.sessions.get({ sessionID: child })
        cost += Number(c.cost ?? 0)
      } catch {
        /* child gone */
      }
    }
    let error: RunStepResult["error"]
    if (outcome === "failed") {
      const messages: any[] = await this.oc.sessions.context({ sessionID }).catch(() => [])
      const last = [...messages].reverse().find((m) => m?.type === "assistant" && m.error)
      if (last?.error) error = { type: last.error.type ?? "unknown", message: last.error.message ?? "", status: last.error.status }
      else error = { type: "unknown", message: "session failed" }
    }
    const text = await lastAssistantText(this.oc, sessionID).catch(() => "")
    return { sessionID, outcome, cost, tokens, model: info.model ?? model, error, text, consults: entry?.consultsMade ?? 0 }
  }

  async interrupt(sessionID: string): Promise<void> {
    try {
      await this.oc.sessions.interrupt({ sessionID })
    } catch {
      /* already idle */
    }
  }

  async review(req: ReviewRequest): Promise<string> {
    const prompt = [req.reviewer.prompt, "", req.prompt, "", ...req.inputs.flatMap((i) => [`=== ${i.path} ===`, i.content.slice(0, 12000)])].join("\n")
    const out = await this.oc.generate.text({ prompt, model: req.model })
    return out?.text ?? ""
  }

  async reply(reply: QuestionReply): Promise<void> {
    if (reply.kind === "permission") {
      await this.oc.permission.reply({ sessionID: reply.sessionID, requestID: reply.requestID, decision: reply.decision, message: reply.message })
    } else {
      if (reply.decision === "reject") await this.oc.sessions.form.cancel({ sessionID: reply.sessionID, formID: reply.requestID })
      else await this.oc.sessions.form.reply({ sessionID: reply.sessionID, formID: reply.requestID, answer: reply.answer ?? {} })
    }
  }

  worktree = {
    create: async (req: WorktreeRequest): Promise<{ directory: string }> => {
      const strategy = this.opts.worktreeStrategy ?? "git"
      const dir = path.join(this.job.root, ".slate", "worktrees", req.name)
      if (strategy === "none") return { directory: req.sourceDirectory }
      if (await isDir(dir)) return { directory: dir }
      if (strategy === "git" && (await isDir(path.join(req.sourceDirectory, ".git")))) {
        try {
          const loc = await this.oc.location.get({ location: { directory: req.sourceDirectory } })
          const projectID = loc?.project?.id
          if (projectID) {
            const wt = await this.oc.worktree.create({ projectID, name: req.name, directory: dir })
            if (wt?.directory) return { directory: wt.directory }
          }
        } catch (e) {
          this.log(`[worktree] sdk create failed, falling back to git: ${(e as Error).message.split("\n")[0]}`)
        }
        const branch = `slate/${req.name}`
        const proc = Bun.spawn(["git", "worktree", "add", "-B", branch, dir], { cwd: req.sourceDirectory, stdout: "pipe", stderr: "pipe" })
        const code = await proc.exited
        if (code === 0) return { directory: dir }
        this.log(`[worktree] git worktree add failed (${code}): ${await new Response(proc.stderr).text()}`)
      }
      await copyDir(req.sourceDirectory, dir)
      await removePath(path.join(dir, ".slate"))
      return { directory: dir }
    },
    remove: async (directory: string): Promise<void> => {
      if (!directory.includes(path.join(".slate", "worktrees"))) return
      const proc = Bun.spawn(["git", "worktree", "remove", "--force", directory], { cwd: this.job.root, stdout: "pipe", stderr: "pipe" })
      if ((await proc.exited) !== 0) await removePath(directory)
    },
  }
}
