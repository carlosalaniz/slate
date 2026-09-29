import { z } from "zod"
import YAML from "yaml"
import { readText, writeTextAtomic, isFile } from "../util/fs.ts"
import { projectPaths } from "./paths.ts"

export const TierSchema = z.enum(["low", "medium", "high"])
export type Tier = z.infer<typeof TierSchema>

export const ExhaustedPolicySimple = z.enum(["ask-human", "ask-decision-agent", "fail"])

/** What a supervised job still asks you about: anything that leaves the project, publishes or destroys. */
export const DEFAULT_ASK_BEFORE = [
  "shell git push*",
  "shell git reset --hard*",
  "shell git clean*",
  "shell rm -rf*",
  "shell sudo *",
  "shell curl *",
  "shell wget *",
  "external_directory *",
  "webfetch *",
]

export const ProjectConfigSchema = z.object({
  name: z.string().min(1).default("slate-job"),
  provider: z.string().min(1).default("anthropic"),
  models: z
    .object({
      low: z.string().min(1),
      medium: z.string().min(1),
      high: z.string().min(1),
    })
    .default({ low: "claude-haiku-4-5-20251001", medium: "claude-sonnet-5", high: "claude-opus-5-5" }),
  /** Caps in USD; omitted or 0 means no cap. Hitting one stops the job: raise it here, then `slate continue`. */
  budget: z
    .object({
      job: z.number().nonnegative().optional(),
      per_task: z.number().nonnegative().optional(),
      per_model: z.record(z.string(), z.number().nonnegative()).default({}),
    })
    .default({ per_model: {} }),
  autonomy: z
    .object({
      question_timeout_hours: z.number().nonnegative().default(8),
      on_timeout: z.enum(["keep-waiting", "take-default", "escalate"]).default("keep-waiting"),
      auto_approve: z.boolean().default(false),
      /**
       * Supervised jobs allow an agent's routine permission requests by themselves and ask you only
       * for these, as "<action> <pattern>" (`*` matches anything; shell patterns see the command).
       */
      ask_before: z.array(z.string().min(1)).default(DEFAULT_ASK_BEFORE),
    })
    .default({ question_timeout_hours: 8, on_timeout: "keep-waiting", auto_approve: false, ask_before: DEFAULT_ASK_BEFORE }),
  pack: z.string().optional(),
  opencode: z.string().default("2.0.15"),
  runtime: z
    .object({
      step_timeout_minutes: z.number().positive().default(90),
      infra_retries: z.number().int().nonnegative().default(3),
      contract_reprompts: z.number().int().nonnegative().default(1),
      worktrees: z.enum(["git", "copy", "none"]).default("git"),
    })
    .default({ step_timeout_minutes: 90, infra_retries: 3, contract_reprompts: 1, worktrees: "git" }),
  /**
   * The escape hatch for requirements. Every tool (`playwright`), model modality (`image-input`,
   * `audio-output`, ...) or discovery need (`audio-synthesis`) listed here is gone without: nothing
   * checks it, and agents are told it is unavailable instead of the job halting.
   */
  capabilities: z.object({ waive: z.array(z.string().min(1)).default([]) }).default({ waive: [] }),
  /** Where `slate skill find` searches: a skills.sh-compatible skill index and an MCP registry. */
  marketplace: z
    .object({
      skills: z.string().url().default("https://skills.sh"),
      tools: z.string().url().default("https://registry.modelcontextprotocol.io"),
    })
    .default({ skills: "https://skills.sh", tools: "https://registry.modelcontextprotocol.io" }),
  config: z.record(z.string(), z.unknown()).default({}),
})
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

export function parseProjectConfig(text: string): ProjectConfig {
  const raw = YAML.parse(text) ?? {}
  return ProjectConfigSchema.parse(raw)
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig | undefined> {
  const p = projectPaths(root).config
  if (!(await isFile(p))) return undefined
  return parseProjectConfig(await readText(p))
}

export async function saveProjectConfig(root: string, config: ProjectConfig): Promise<void> {
  const p = projectPaths(root).config
  const header = "# Slate project configuration. Written by `slate init`; edit freely.\n"
  await writeTextAtomic(p, header + YAML.stringify(config))
}

/** "name@version" -> { name, version } */
export function parsePackRef(ref: string): { name: string; version?: string } {
  const at = ref.lastIndexOf("@")
  if (at <= 0) return { name: ref }
  return { name: ref.slice(0, at), version: ref.slice(at + 1) }
}
