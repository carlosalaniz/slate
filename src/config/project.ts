import { z } from "zod"
import YAML from "yaml"
import { readText, writeTextAtomic, isFile } from "../util/fs.ts"
import { projectPaths } from "./paths.ts"

export const TierSchema = z.enum(["low", "medium", "high"])
export type Tier = z.infer<typeof TierSchema>

export const ExhaustedPolicySimple = z.enum(["ask-human", "ask-decision-agent", "fail"])

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
  /** Caps in USD; 0 means no cap. Hitting one stops the job: raise it here, then `slate continue`. */
  budget: z
    .object({
      job: z.number().nonnegative().default(200),
      per_task: z.number().nonnegative().default(5),
      per_model: z.record(z.string(), z.number().nonnegative()).default({}),
    })
    .default({ job: 200, per_task: 5, per_model: {} }),
  autonomy: z
    .object({
      question_timeout_hours: z.number().nonnegative().default(8),
      on_timeout: z.enum(["keep-waiting", "take-default", "escalate"]).default("keep-waiting"),
      auto_approve: z.boolean().default(false),
    })
    .default({ question_timeout_hours: 8, on_timeout: "keep-waiting", auto_approve: false }),
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
