import { z } from "zod"

/** Pack schema (slate: 1). Authors write YAML and markdown only. */

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase kebab-case")

export const ExhaustedSimple = z.enum(["ask-human", "ask-decision-agent", "fail"])
export type ExhaustedSimple = z.infer<typeof ExhaustedSimple>

/** Values may still contain `${var}` placeholders at parse time; resolution happens in the loader. */
const NumberOrVar = z.union([z.number().int().nonnegative(), z.string().regex(/^\$\{[a-zA-Z0-9_]+\}$/)])
/**
 * What an `until` loop does when it runs out of rounds:
 *  - ask-human / ask-decision-agent: retry with `max` more rounds, skip the loop, or stop the job
 *  - fail: the loop fails, which fails the round of the enclosing `until` loop (or the job, if none)
 */
export const ExhaustedPolicy = z.union([ExhaustedSimple, z.string().regex(/^\$\{[a-zA-Z0-9_]+\}$/)], {
  error: "on_exhausted must be ask-human, ask-decision-agent or fail. (goto was removed: to redo earlier steps, wrap them in an outer until loop)",
})
export type ExhaustedPolicy = z.infer<typeof ExhaustedPolicy>

export const ScopeSchema = z.object({
  modify: z.array(z.string()).optional(),
  read: z.array(z.string()).optional(),
})
export type Scope = z.infer<typeof ScopeSchema>

export const PermissionRuleSchema = z.object({
  action: z.string(),
  resource: z.string(),
  effect: z.enum(["allow", "deny", "ask"]),
})
export type PermissionRule = z.infer<typeof PermissionRuleSchema>

export const ConsultSchema = z.object({
  agents: z.array(Id).min(1),
  max: z.number().int().positive().default(2),
  steps: z.number().int().positive().default(8),
})
export type ConsultPolicy = z.infer<typeof ConsultSchema>

export const GateSchema = z.object({
  on: z.object({ action: z.string(), resource: z.string().default("*") }),
  review: z.array(Id).default([]),
  inputs: z.array(z.string()).default([]),
  else: z.enum(["ask-human", "deny"]).default("ask-human"),
})
export type Gate = z.infer<typeof GateSchema>

export const ResultSchema = z.object({
  file: z.string(),
  field: z.string().default("verdict"),
})

export const SkillStepSchema = z.object({
  id: Id,
  type: z.literal("skill"),
  skill: Id,
  by: Id,
  model: z.enum(["low", "medium", "high"]).optional(),
  writes: z.array(z.string()).default([]),
  result: ResultSchema.optional(),
  scope: z
    .object({
      from: z.string().optional(),
      within: ScopeSchema.optional(),
      modify: z.array(z.string()).optional(),
      read: z.array(z.string()).optional(),
    })
    .optional(),
  consult: ConsultSchema.optional(),
  gates: z.array(GateSchema).optional(),
  prompt: z.string().optional(),
})

export const ScriptRef = z.object({
  script: Id,
  args: z.array(z.string()).default([]),
})

export const ScriptStepSchema = z.object({
  id: Id,
  type: z.literal("script"),
  script: Id,
  args: z.array(z.string()).default([]),
})

export const ApprovalStepSchema = z.object({
  id: Id,
  type: z.literal("approval"),
  prompt: z.string(),
  show: z.array(z.string()).default([]),
})

/**
 * When an `until` loop's round passes:
 *  - `{ result: <step> }`: that step's verdict is `pass`
 *  - `{ script, args }`: the script answers `{ "pass": true }`
 *  - `all-pass`: every step in the round passed (a failure or a rejected approval fails the round)
 */
export type UntilCondition = { script: string; args: string[] } | { result: string } | "all-pass"

export type LoopStep = {
  id: string
  type: "loop"
  over?: { script: string; args: string[] }
  as?: string
  until?: UntilCondition
  max: number | string
  concurrency?: number | string
  on_exhausted?: ExhaustedPolicy
  /** Give each iteration its own worktree. Defaults to true for `as: task` loops in build. */
  worktree?: boolean
  steps: Step[]
}
export type Step = z.infer<typeof SkillStepSchema> | z.infer<typeof ScriptStepSchema> | z.infer<typeof ApprovalStepSchema> | LoopStep

export const LoopStepSchema: z.ZodType<LoopStep> = z.lazy(() =>
  z
    .object({
      id: Id,
      type: z.literal("loop"),
      over: ScriptRef.optional(),
      as: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).optional(),
      until: z.union([ScriptRef, z.object({ result: Id }), z.literal("all-pass")]).optional(),
      max: NumberOrVar,
      concurrency: NumberOrVar.optional(),
      on_exhausted: ExhaustedPolicy.optional(),
      worktree: z.boolean().optional(),
      steps: z.array(StepSchema).min(1),
    })
    .superRefine((v, ctx) => {
      if (!v.over && !v.until) ctx.addIssue({ code: "custom", message: `loop ${v.id}: needs one of over/until` })
      if (v.over && v.until) ctx.addIssue({ code: "custom", message: `loop ${v.id}: over and until are exclusive` })
      if (v.over && !v.as) ctx.addIssue({ code: "custom", message: `loop ${v.id}: over requires as` })
    }),
) as z.ZodType<LoopStep>

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("type", [SkillStepSchema, ScriptStepSchema, ApprovalStepSchema, LoopStepSchema as never]),
) as z.ZodType<Step>

export type SkillStep = z.infer<typeof SkillStepSchema>
export type ScriptStep = z.infer<typeof ScriptStepSchema>
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>

export const PHASES = ["discovery", "plan", "build", "close"] as const
export type PackPhase = (typeof PHASES)[number]

export const ManifestSchema = z.object({
  slate: z.literal(1),
  name: Id,
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().default(""),
  fits: z.string().default(""),
  inputs: z.array(z.string()).default(["brief"]),
  outputs: z.array(z.string()).default([]),
  requires: z.record(z.string(), z.string()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
  /**
   * Live discovery with the person (`slate discover`): once they pick this pack, the conversation is
   * handed to `lead`, which runs the rest of the interview and delegates the discovery documents
   * (the files written by skill steps in phases.discovery) to the agents that own them.
   */
  discovery: z.object({ lead: Id.optional() }).default({}),
  phases: z.object({
    discovery: z.array(StepSchema).default([]),
    plan: z.array(StepSchema).default([]),
    build: z.array(StepSchema).default([]),
    close: z.array(StepSchema).default([]),
  }),
})
export type Manifest = z.infer<typeof ManifestSchema>

export const AgentFileSchema = z.object({
  description: z.string().default(""),
  role: z.enum(["worker", "consultant", "reviewer"]).default("worker"),
  model: z.enum(["low", "medium", "high"]).default("medium"),
  scope: ScopeSchema.default({}),
  permissions: z.array(PermissionRuleSchema).default([]),
  steps: z.number().int().positive().optional(),
  prompt: z.string().default(""),
})
export type AgentFile = z.infer<typeof AgentFileSchema>
export interface AgentSpec extends AgentFile {
  id: string
}

export const SkillFileSchema = z.object({
  description: z.string().default(""),
  reads: z.array(z.string()).default([]),
  prompt: z.string().min(1),
})
export type SkillFile = z.infer<typeof SkillFileSchema>
export interface SkillSpec extends SkillFile {
  id: string
}

export const ScriptFileSchema = z.object({
  description: z.string().default(""),
  run: z.string().min(1),
  timeout: z.union([z.string(), z.number()]).default("30s"),
})
export type ScriptFile = z.infer<typeof ScriptFileSchema>
export interface ScriptSpec extends ScriptFile {
  id: string
  timeoutMs: number
}

export const VERDICTS = ["pass", "fail"] as const
export type Verdict = (typeof VERDICTS)[number]
