import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { z } from "zod"
import { isFile, readText } from "../util/fs.ts"

/**
 * `.slate_defaults.yml`: answers for `slate init`, so trying Slate out does not mean answering the
 * same prompts every time. Same keys as slate.config.yml (all optional), plus `discover: false` to
 * skip opening discovery. Looked up in the project directory, its parents, then the home directory;
 * the first file found wins. Flags still override it.
 */
export const DEFAULTS_FILE = ".slate_defaults.yml"

const Tier = z.string().min(1)
export const InitDefaultsSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    models: z.object({ low: Tier, medium: Tier, high: Tier }).partial(),
    budget: z.object({ job: z.number().nonnegative(), per_task: z.number().nonnegative(), per_model: z.record(z.string(), z.number().nonnegative()) }).partial(),
    autonomy: z.object({ question_timeout_hours: z.number().nonnegative(), on_timeout: z.enum(["keep-waiting", "take-default", "escalate"]) }).partial(),
    pack: z.string().min(1),
    opencode: z.string().min(1),
    runtime: z.record(z.string(), z.unknown()),
    config: z.record(z.string(), z.unknown()),
    discover: z.boolean(),
  })
  .partial()
  .strict()
export type InitDefaults = z.infer<typeof InitDefaultsSchema>

/** The nearest defaults file and its values, or undefined when there is none. */
export async function loadInitDefaults(root: string): Promise<{ file: string; values: InitDefaults } | undefined> {
  for (const dir of searchDirs(root)) {
    const file = path.join(dir, DEFAULTS_FILE)
    if (!(await isFile(file))) continue
    const parsed = InitDefaultsSchema.safeParse(YAML.parse(await readText(file)) ?? {})
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`)
    return { file, values: parsed.data }
  }
  return undefined
}

function searchDirs(root: string): string[] {
  const dirs: string[] = []
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    dirs.push(dir)
    if (path.dirname(dir) === dir) break
  }
  const home = os.homedir()
  if (!dirs.includes(home)) dirs.push(home)
  return dirs
}
