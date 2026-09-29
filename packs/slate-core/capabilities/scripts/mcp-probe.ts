/**
 * Checks a local MCP server without spending anything: starts it (the command in
 * SLATE_MCP_COMMAND), runs the MCP handshake and lists its tools. The server's environment comes
 * from Slate (the variables its capability names, from the environment or the project's .env).
 * Prints `{ "ok": true, "tools": n }` or `{ "ok": false, "reason": ... }`.
 *
 * `probeMcp` is also imported by checks that go one step further (playwright opens a page).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
  /** A call to make afterwards, e.g. closing what the first one opened. */
  then?: ToolCall
}

/** initialize -> tools/list [-> call] over stdio. Returns what went wrong, if anything. */
export async function probeMcp(cmd: string[], call?: ToolCall, env: Record<string, string> = {}): Promise<string | undefined> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "slate-mcp-"))
  const args = cmd.map((a, i) => (cmd[i - 1] === "--output-dir" ? out : a))
  const proc = Bun.spawn(args, { cwd: out, env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
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
    if (!tools.length) return "lists no tools"
    let id = 3
    for (let c: ToolCall | undefined = call; c; c = c.then) {
      if (!tools.includes(c.name)) return `lists no ${c.name} tool (${tools.slice(0, 5).join(", ")})`
      send({ id, method: "tools/call", params: { name: c.name, arguments: c.arguments } })
      const res = await receive(id++)
      const text = JSON.stringify(res.result?.content ?? res.error ?? "")
      if (res.error || res.result?.isError || /### Error/.test(text)) return `failed calling ${c.name}: ${text.replace(/\\n/g, " ").slice(0, 300)}`
    }
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

if (import.meta.main) {
  const reply = (answer: Record<string, unknown>): never => {
    process.stdout.write(JSON.stringify(answer) + "\n")
    process.exit(0)
  }
  const command = JSON.parse(process.env.SLATE_MCP_COMMAND ?? "null") as string[] | null
  if (!command?.length) reply({ ok: false, reason: "no MCP command to check (SLATE_MCP_COMMAND)" })
  const problem = await probeMcp(command!)
  reply(problem ? { ok: false, reason: `the MCP server (${command!.join(" ")}) ${problem}` } : { ok: true })
}
