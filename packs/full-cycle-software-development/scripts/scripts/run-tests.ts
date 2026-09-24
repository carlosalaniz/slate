/** Runs the project's test command from specs/tech-spec.md (a line like "test command: `bun test`"), else `npm test`. */
import fs from "node:fs"
import path from "node:path"
import { workspace, reply } from "./lib.ts"

const spec = path.join(workspace, "specs", "tech-spec.md")
const fromSpec = fs.existsSync(spec) ? /test command[^`\n]*`([^`]+)`/i.exec(fs.readFileSync(spec, "utf8"))?.[1] : undefined
const command = fromSpec ?? "npm test"

const run = Bun.spawnSync(["sh", "-c", command], { cwd: workspace })
const output = `${run.stderr.toString()}${run.stdout.toString()}`
reply(run.exitCode === 0 ? { pass: true } : { pass: false, reason: output.slice(-1500) })
