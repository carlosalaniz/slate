import type { SkillStep } from "../pack/schema.ts"
import type { InstalledPack } from "../pack/registry.ts"
import { loadPack } from "../pack/loader.ts"
import { isFile, readText } from "../util/fs.ts"
import type { Engine } from "./engine.ts"
import type { Ctx } from "./job.ts"
import { JobFailed, type LoadedPack, type QuestionOption } from "./types.ts"
import { baseVars, jobContext, tier } from "./prepare.ts"
import { runSkill } from "./step.ts"
import { openQuestion, waitForAnswer } from "./inbox.ts"
import { proposePackOffline, renderPrompt } from "./core-pack.ts"

/**
 * intake — runs once per job: turn the idea into `.slate/brief.md` (unless one was given), then pick
 * the pack (unless one was given) and pin it in state.json. The agents and prompts are slate-core's.
 */

/** Intake needs a runtime before any pack is chosen; it runs against an empty pack. */
const NO_PACK: Omit<LoadedPack, "dir"> = {
  manifest: { slate: 1, name: "intake", version: "0.0.0", description: "", fits: "", inputs: [], outputs: [], requires: {}, config: {}, discovery: {}, phases: { discovery: [], plan: [], build: [], close: [] } },
  agents: {},
  skills: {},
  scripts: {},
  capabilities: {},
  config: {},
}

export async function runIntake(engine: Engine): Promise<void> {
  engine.log("== phase intake ==")
  const core = engine.core!
  const shell: LoadedPack = engine.pack ?? { dir: engine.o.root, ...NO_PACK }
  let started = false
  const start = async () => {
    if (!started) await engine.o.runtime.start(jobContext(engine, shell))
    started = true
  }
  try {
    if (!(await isFile(engine.o.paths.brief))) {
      await start()
      const step: SkillStep = { id: "write-brief", type: "skill", skill: "slate-write-brief", by: "slate-intake", writes: [".slate/brief.md"] }
      const ctx: Ctx = { prefix: "intake", branch: "main", vars: { ...baseVars(engine), idea: engine.state.job.idea ?? "" }, directory: engine.o.root, phase: "intake", untilStack: [] }
      const res = await runSkill(engine, step, ctx, core.agents["slate-intake"]!, core.skills["slate-write-brief"]!)
      if (res.failed) throw new JobFailed(`intake could not write .slate/brief.md: ${res.reason}`)
    }
    if (!engine.pack) {
      const chosen = await proposePack(engine, await readText(engine.o.paths.brief), start)
      if (!chosen) throw new JobFailed("no installed pack fits this brief; install one with `slate pack add <dir>` or pass --pack")
      engine.pack = await loadPack(chosen.dir, engine.o.project.config, { projectRoot: engine.o.root })
      engine.log(`pack: ${chosen.name}@${chosen.version}`)
    }
  } finally {
    if (started) await engine.o.runtime.close()
  }
  const pack = engine.pack!
  await engine.o.state.update((s) => {
    s.job.pack = { name: pack.manifest.name, version: pack.manifest.version, dir: pack.dir }
    s.config = pack.config
    s.phase = "discovery"
  })
}

/** A model proposes a pack (keyword matching when offline); a human confirms it, or auto-approve takes it. */
async function proposePack(engine: Engine, brief: string, start: () => Promise<void>): Promise<InstalledPack | undefined> {
  const packs = engine.o.installedPacks.filter((p) => p.version !== "invalid")
  if (packs.length === 0) return undefined
  let proposed: InstalledPack | undefined
  let reasoning = ""
  if (engine.o.runtime.kind === "opencode") {
    try {
      await start()
      const proposer = engine.core!.agents["slate-pack-proposer"]!
      const list = packs.map((p) => `- ${p.name}@${p.version}: fits: ${p.fits || "(no fits description)"} | ${p.description}`).join("\n")
      const text = await engine.o.runtime.review({ reviewer: proposer, model: tier(engine, proposer.model), prompt: renderPrompt(engine.core!, "pack-proposal", { packs: list, brief: brief.slice(0, 6000) }), inputs: [] })
      const [first, ...rest] = text.trim().split("\n")
      const name = (first ?? "").trim().replace(/@.*$/, "")
      reasoning = rest.join(" ").trim()
      proposed = name === "none" ? undefined : packs.find((p) => p.name === name)
    } catch (e) {
      engine.log(`pack proposal via model failed (${(e as Error).message}); matching offline`)
    }
  }
  proposed ??= proposePackOffline(brief, packs)
  const options: QuestionOption[] = [
    ...(proposed ? [{ id: proposed.name, label: `${proposed.name}@${proposed.version} (proposed)`, default: true }] : []),
    ...packs.filter((p) => p.name !== proposed?.name).map((p) => ({ id: p.name, label: `${p.name}@${p.version}: ${p.fits}` })),
    { id: "none", label: "none of these; stop" },
  ]
  const q = await openQuestion(engine, {
    kind: "pack",
    prompt: proposed ? `Proposed pack: ${proposed.name}@${proposed.version}. ${reasoning || proposed.fits}`.trim() : "No installed pack clearly fits this brief. Choose one anyway, or stop.",
    context: [brief.slice(0, 2000)],
    options,
    branch: "main",
    autoAnswer: proposed?.name,
  })
  const answer = await waitForAnswer(engine, q.id)
  return answer === "none" ? undefined : packs.find((p) => p.name === answer)
}
