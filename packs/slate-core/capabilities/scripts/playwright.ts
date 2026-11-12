/**
 * Checks that Playwright works here, without spending anything:
 *  - for scripts: the library resolves (from the project first, then from Slate), its Chromium is
 *    installed, and a headless launch and close succeeds;
 *  - for agents: the MCP server from playwright.yml (passed in SLATE_MCP_COMMAND) starts, lists its
 *    tools and opens a blank page in its own browser.
 * Prints `{ "ok": true }` or `{ "ok": false, "reason": ... }`.
 */
import fs from "node:fs"
import path from "node:path"
import { probeMcp } from "./mcp-probe.ts"

const reply = (answer: Record<string, unknown>): never => {
  process.stdout.write(JSON.stringify(answer) + "\n")
  process.exit(0)
}

const workspace = process.env.SLATE_WORKSPACE ?? process.cwd()
/** Playwright installed at or above `from`. Only installed copies: resolving from a directory with no
 * node_modules makes Bun auto-install the latest release, whose browser build is not downloaded. */
function installedPlaywright(from: string): string | undefined {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node_modules", "playwright", "package.json"))) return Bun.resolveSync("playwright", dir)
    if (path.dirname(dir) === dir) return undefined
  }
}

let entry: string | undefined
for (const from of [workspace, import.meta.dir]) {
  entry = installedPlaywright(from)
  if (entry) break
}
if (!entry) reply({ ok: false, reason: "the playwright package is not installed in the project or next to Slate" })

const { chromium } = (await import(entry!)) as typeof import("playwright")
const executable = chromium.executablePath()
if (!executable || !fs.existsSync(executable)) reply({ ok: false, reason: `Chromium for Playwright is not installed (expected ${executable || "a browser binary"})` })
try {
  const browser = await chromium.launch({ headless: true, timeout: 30_000 })
  await browser.close()
} catch (e) {
  reply({ ok: false, reason: `Chromium did not launch: ${String((e as Error).message).split("\n")[0]}` })
}

const command = JSON.parse(process.env.SLATE_MCP_COMMAND ?? "null") as string[] | null
if (command?.length) {
  const problem = await probeMcp(command, { name: "browser_navigate", arguments: { url: "data:text/html,<p>slate</p>" }, then: { name: "browser_close", arguments: {} } })
  if (problem) reply({ ok: false, reason: `the Playwright MCP server (${command.join(" ")}) ${problem}` })
}
reply({ ok: true, library: path.dirname(entry!), browser: executable, mcp: Boolean(command?.length) })
