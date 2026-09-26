/**
 * Checks that Playwright works here, without spending anything:
 *  - for scripts: the library resolves (from the project first, then from Slate), its Chromium is
 *    installed, and a headless launch and close succeeds;
 *  - for agents: the MCP server from playwright.yml (passed in SLATE_MCP_COMMAND) starts, lists its
 *    tools and opens a blank page in its own browser.
 * Prints `{ "ok": true }` or `{ "ok": false, "reason": ... }`.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const reply = (answer: Record<string, unknown>): never => {
  process.stdout.write(JSON.stringify(answer) + "\n")
  process.exit(0)
}

const workspace = process.env.SLATE_WORKSPACE ?? process.cwd()
let entry: string | undefined
for (const from of [workspace, import.meta.dir]) {
  try {
    entry = Bun.resolveSync("playwright", from)
    break
  } catch {
    /* try the next place */
  }
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
  const problem = await probeMcp(command)
  if (problem) reply({ ok: false, reason: `the Playwright MCP server (${command.join(" ")}) ${problem}` })
}
reply({ ok: true, library: path.dirname(entry!), browser: executable, mcp: Boolean(command?.length) })

/** initialize -> tools/list -> browser_navigate(data:) -> browser_close over stdio. Returns what went wrong, if anything. */
async function probeMcp(cmd: string[]): Promise<string | undefined> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "slate-pw-"))
  const args = cmd.map((a, i) => (cmd[i - 1] === "--output-dir" ? out : a))
  const proc = Bun.spawn(args, { cwd: out, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const send = (m: Record<string, unknown>) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n")
    proc.stdin.flush()
  }
  const receive = async (id: number): Promise<any> => {
    while (true) {
      const nl = buffer.indexOf("\n")
      if (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        try {
          const m = JSON.parse(line)
          if (m.id === id) return m
        } catch {
          /* not a message */
        }
        continue
      }
      const { value, done } = await reader.read()
      if (done) throw new Error("exited")
      buffer += decoder.decode(value)
    }
  }
  const timer = setTimeout(() => proc.kill(), 150_000)
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "slate-check", version: "1" } } })
    await receive(1)
    send({ method: "notifications/initialized" })
    send({ id: 2, method: "tools/list" })
    const tools: string[] = ((await receive(2)).result?.tools ?? []).map((t: { name: string }) => t.name)
    if (!tools.includes("browser_navigate")) return `lists no browser_navigate tool (${tools.slice(0, 5).join(", ") || "no tools"})`
    send({ id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "data:text/html,<p>slate</p>" } } })
    const nav = await receive(3)
    const text = JSON.stringify(nav.result?.content ?? nav.error ?? "")
    if (nav.error || nav.result?.isError || /### Error/.test(text)) return `could not open a page: ${text.replace(/\\n/g, " ").slice(0, 300)}`
    send({ id: 4, method: "tools/call", params: { name: "browser_close", arguments: {} } })
    await receive(4)
    return undefined
  } catch (e) {
    const err = await new Response(proc.stderr).text().catch(() => "")
    return `did not answer (${(e as Error).message}${err.trim() ? `: ${err.trim().split("\n").slice(-1)[0]}` : ""})`
  } finally {
    clearTimeout(timer)
    proc.kill()
    fs.rmSync(out, { recursive: true, force: true })
  }
}
