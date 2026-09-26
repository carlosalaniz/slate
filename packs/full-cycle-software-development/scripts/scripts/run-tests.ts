/**
 * Runs the project's test command after a build and records the result in
 * `tasks/<task>/design-<n>/tests-<round>.md`, so a failing build goes straight back to the builder
 * with the output and a passing one reaches the checker with the tests already run.
 *
 * The command comes from specs/tech-spec.md (a line like "test command: `bun test`"), else
 * `npm test` when package.json has a test script. No command at all (an early task, before the
 * project has tests) passes with a note. Tests that hang past the limit fail the check instead of
 * killing the script, since watch-mode test runners are a common way to hang.
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, reply, broken } from "./lib.ts"

const [task, design, round] = process.argv.slice(2)
if (!task || !design || !round) broken("usage: run-tests <task> <design round> <build round>")

const LIMIT_MS = 8 * 60_000
const KEEP_CHARS = 8000

const record = `tasks/${task}/design-${design}/tests-${round}.md`
const write = (verdict: "pass" | "fail", header: Record<string, string | number>, body: string) => {
  const file = path.join(workspace, record)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const meta = Object.entries({ verdict, ...header }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  fs.writeFileSync(file, `---\n${meta.join("\n")}\n---\n${body}\n`)
}

const spec = path.join(workspace, "specs", "tech-spec.md")
const fromSpec = fs.existsSync(spec) ? /test command[^`\n]*`([^`]+)`/i.exec(fs.readFileSync(spec, "utf8"))?.[1] : undefined
const pkg = path.join(workspace, "package.json")
const npmTest = fs.existsSync(pkg) && hasTestScript(fs.readFileSync(pkg, "utf8"))
const command = fromSpec ?? (npmTest ? "npm test" : undefined)

if (!command) {
  write("pass", { command: "none" }, "No test command yet: specs/tech-spec.md names none and package.json has no test script.")
  reply({ ok: true, pass: true, note: "no test command", record })
}

const started = Date.now()
const run = Bun.spawnSync(["sh", "-c", command], { cwd: workspace, env: { ...process.env, CI: "1" }, stdout: "pipe", stderr: "pipe", timeout: LIMIT_MS })
const seconds = Math.round((Date.now() - started) / 1000)
const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim()
const tail = output.length > KEEP_CHARS ? `(earlier output cut)\n${output.slice(-KEEP_CHARS)}` : output
const timedOut = run.exitCode === null
const passed = run.exitCode === 0

write(passed ? "pass" : "fail", { command, exit: timedOut ? "timeout" : run.exitCode!, seconds }, `\`\`\`\n${tail || "(no output)"}\n\`\`\``)
if (passed) reply({ ok: true, pass: true, record })
const why = timedOut ? `tests still running after ${LIMIT_MS / 60_000} minutes` : `tests failed (exit ${run.exitCode})`
reply({ ok: false, pass: false, reason: `${why}; output in ${record}`, record })

/** A package.json that does not parse counts as having tests: `npm test` then fails with the reason. */
function hasTestScript(json: string): boolean {
  try {
    return Boolean((JSON.parse(json) as { scripts?: Record<string, string> }).scripts?.test)
  } catch {
    return true
  }
}
