import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { register } from "../main.ts"
import { CliError } from "../output.ts"
import { requireProject } from "../context.ts"
import { spin } from "../prompt.ts"
import { checkDiscovery } from "../discovery.ts"
import { StateStore } from "../../engine/state.ts"
import { loadCorePack } from "../../engine/core-pack.ts"
import { collectRequirements, mcpServers, preflight, waivedIds, writeCatalog } from "../../engine/capabilities.ts"
import type { JobContext, Phase } from "../../engine/types.ts"
import { loadPack } from "../../pack/loader.ts"
import { findPack } from "../../pack/registry.ts"
import { makeRuntime } from "./run-job.ts"

register(
  "check",
  `slate check [--json]
Checks what the job needs before it spends anything, exactly as \`slate start\` and \`slate continue\` do: every tool
the pack's agents, skills and scripts require (each capability's own check, and its MCP server), the model
modalities they need (image input, ...) on the tiers they run on, and what discovery listed in the pack's needs
file (specs/capabilities.yaml). No check calls a model. Waive what you want to go without in slate.config.yml
(capabilities.waive). Exits 1 when something is missing.`,
  async (_argv, out) => {
    const p = await requireProject()
    const state = await StateStore.read(p.paths.state)
    const discovery = await checkDiscovery(p.paths)
    const open = state && state.status !== "done" && state.status !== "failed" ? state : undefined
    const ref = open?.job.pack?.dir ?? discovery.pack?.dir ?? (p.config.pack ? (await findPack(p.config.pack, p.root))?.dir : undefined)
    if (!ref) throw new CliError("no pack chosen yet", "run `slate discover` first; it picks the pack")
    const pack = await loadPack(ref, p.config.config)
    const core = await loadCorePack()
    // The checks cover the phases still to run: an open job's, or a new job's (plan once discovery is done).
    const phase: Phase = open && open.phase !== "intake" && open.phase !== "done" ? open.phase : discovery.done ? "plan" : "discovery"

    const scratch = await mkdtemp(path.join(os.tmpdir(), "slate-check-"))
    const runtime = makeRuntime(p, false, (line) => out.err(line))
    try {
      const ctx = { root: p.root, project: p.config, runtime, core, phase, runId: "check" }
      const req = await collectRequirements(ctx, pack, phase)
      const servers = mcpServers(pack, req, waivedIds(p.config))
      const job: JobContext = {
        jobId: "check",
        root: p.root,
        pack,
        project: p.config,
        tier: (t) => ({ providerID: p.config.provider, id: p.config.models[t] }),
        // Its own database: a running engine keeps the project's open.
        consultsDir: path.join(scratch, "consults"),
        dbPath: path.join(scratch, "opencode.db"),
        activityPath: path.join(scratch, "activity.json"),
        core,
        toolAccess: () => ({ registered: servers.map((s) => s.name), shared: [...req.sharedTools] }),
      }
      const result = await (out.json ? run() : spin("checking requirements (no model calls)…", run()))
      async function run() {
        await runtime.start(job)
        await runtime.ensureMcp(servers)
        await writeCatalog(p.root, pack, core)
        return preflight(ctx, pack, req)
      }
      const skip = waivedIds(p.config)
      const human = () => [
        `requirements for ${pack.manifest.name}@${pack.manifest.version} (phases from ${phase} on)`,
        ...(result.checked.length ? [`  checked: ${result.checked.join(", ")}`] : ["  nothing to check"]),
        ...(skip.size ? [`  waived:  ${[...skip].join(", ")}`] : []),
        ...(result.ok ? ["all present"] : ["missing:", ...result.problems.map((x) => `  - ${x}`)]),
      ]
      out.emit(human, { pack: `${pack.manifest.name}@${pack.manifest.version}`, phase, ok: result.ok, checked: result.checked, waived: [...skip], problems: result.problems })
      return result.ok ? 0 : 1
    } finally {
      await runtime.close()
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  },
)
