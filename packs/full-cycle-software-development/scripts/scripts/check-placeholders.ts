/**
 * The last gate before the run is summarized: nothing may ship as a stand-in without anyone
 * deciding so. Builders list the stand-ins they create (silent audio, lorem text, a fake API key)
 * under `placeholders:` in their build report's frontmatter. A stand-in is still there when its file
 * exists and no commit changed it after the one that added it (outside git: when it exists).
 *
 * Outstanding stand-ins are written to stories/placeholders.md (the run summary reports them).
 * With `placeholders: halt` (the default) they halt the job: make the real thing, or set
 * `placeholders: report` in slate.config.yml's pack config to ship them knowingly.
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, reply, git } from "./lib.ts"

const mode = process.argv[2] === "report" ? "report" : "halt"
const report = path.join(workspace, "stories", "placeholders.md")

interface Placeholder {
  path: string
  stands_in_for?: string
  task: string
}
const found: Placeholder[] = []
const tasksDir = path.join(workspace, "tasks")
for (const task of fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : []) {
  const latest = latestBuildReport(path.join(tasksDir, task))
  if (!latest) continue
  const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(latest, "utf8"))?.[1]
  if (!front) continue
  let meta: { placeholders?: unknown } = {}
  try {
    meta = (Bun.YAML.parse(front) ?? {}) as typeof meta
  } catch {
    continue
  }
  for (const p of Array.isArray(meta.placeholders) ? meta.placeholders : []) {
    if (typeof p === "string") found.push({ path: p, task })
    else if (p && typeof p === "object" && typeof (p as Placeholder).path === "string") found.push({ path: (p as Placeholder).path, stands_in_for: (p as Placeholder).stands_in_for, task })
  }
}

const inGit = git(["rev-parse", "--is-inside-work-tree"]).ok
const outstanding: (Placeholder & { files: string[] })[] = []
for (const p of found) {
  const files = [...new Bun.Glob(p.path).scanSync({ cwd: workspace, onlyFiles: true })].filter((f) => stillStandIn(f))
  if (files.length) outstanding.push({ ...p, files })
}

if (!outstanding.length) {
  fs.rmSync(report, { force: true })
  reply({ ok: true, placeholders: 0 })
}
const lines = ["# Stand-ins still in the product", "", "Builders created these as placeholders, and nothing has replaced them yet.", ""]
for (const p of outstanding) lines.push(`- \`${p.path}\` (${p.files.length} file${p.files.length === 1 ? "" : "s"}, task ${p.task})${p.stands_in_for ? `: stands in for ${p.stands_in_for}` : ""}`)
fs.mkdirSync(path.dirname(report), { recursive: true })
fs.writeFileSync(report, lines.join("\n") + "\n")
const summary = outstanding.map((p) => `${p.path} (${p.files.length}${p.stands_in_for ? `, for ${p.stands_in_for}` : ""})`).join("; ")
if (mode === "report") reply({ ok: true, placeholders: outstanding.length, report: "stories/placeholders.md" })
reply({ ok: false, halt: true, reason: `stand-ins would ship as the product: ${summary}. Listed in stories/placeholders.md. Replace them (a skill or tool may be missing: see specs/capabilities.yaml), or set \`placeholders: report\` in slate.config.yml config to ship them knowingly.` })

function latestBuildReport(taskDir: string): string | undefined {
  const reports: { file: string; design: number; round: number }[] = []
  for (const d of fs.readdirSync(taskDir)) {
    const design = /^design-(\d+)$/.exec(d)?.[1]
    if (!design) continue
    for (const f of fs.readdirSync(path.join(taskDir, d))) {
      const round = /^build-(\d+)\.md$/.exec(f)?.[1]
      if (round) reports.push({ file: path.join(taskDir, d, f), design: Number(design), round: Number(round) })
    }
  }
  return reports.sort((a, b) => b.design - a.design || b.round - a.round)[0]?.file
}

/** Unchanged since it was added: one commit touches it (or, outside git, it exists). */
function stillStandIn(file: string): boolean {
  if (!inGit) return true
  const commits = git(["log", "--format=%H", "--", file]).out.split("\n").filter(Boolean)
  return commits.length <= 1
}
