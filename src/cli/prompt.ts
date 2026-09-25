import { createInterface } from "node:readline/promises"
import { CliError } from "./output.ts"

/**
 * Minimal interactive prompts: an arrow-key selector and a line input with a
 * default, both on a raw-mode TTY, plus a cooked-mode `line` for long text.
 * Each prompt attaches to `process.stdin` and detaches when done, so prompts
 * run back to back without losing input. Callers must check `process.stdin.isTTY` first.
 */

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = paint("2")
const cyan = paint("36")
const green = paint("32")
const bold = paint("1")

const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"
const write = (s: string) => process.stdout.write(s)

/** Feeds raw key chunks to `onKey` until it returns a value; restores the terminal either way. */
function withRawKeys<T>(onKey: (key: string) => { done: T } | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const finish = (fn: () => void) => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      write(SHOW_CURSOR)
      fn()
    }
    const onData = (buf: Buffer) => {
      for (const key of splitKeys(buf.toString("utf8"))) {
        if (key === "\x03" || key === "\x04") return finish(() => reject(new CliError("aborted", undefined, 130)))
        const r = onKey(key)
        if (r) return finish(() => resolve(r.done))
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
  })
}

/** Splits a chunk into keys: escape sequences stay whole, everything else is per character (pastes included). */
function splitKeys(chunk: string): string[] {
  const keys: string[] = []
  for (let i = 0; i < chunk.length; ) {
    const m = chunk[i] === "\x1b" ? /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(chunk.slice(i)) : null
    const k = m ? m[0] : [...chunk.slice(i, i + 2)][0]!
    keys.push(k)
    i += k.length
  }
  return keys
}

export interface Choice<T extends string> {
  value: T
  label?: string
  hint?: string
}

/**
 * Arrow keys (or j/k) to move, Enter to pick, a digit jumps straight to that option. Lists longer
 * than `pageSize` scroll, and typing filters them instead (digits and j/k then go to the filter).
 */
export async function select<T extends string>(message: string, choices: readonly Choice<T>[], def?: T, opts: { pageSize?: number } = {}): Promise<T> {
  const pageSize = opts.pageSize ?? 10
  const filterable = choices.length > pageSize
  let query = ""
  let shown: readonly Choice<T>[] = choices
  let i = Math.max(0, choices.findIndex((c) => c.value === def))
  let top = 0
  let drawn = 0
  const refilter = () => {
    const q = query.toLowerCase()
    shown = q ? choices.filter((c) => `${c.value} ${c.label ?? ""} ${c.hint ?? ""}`.toLowerCase().includes(q)) : choices
    i = 0
    top = 0
  }
  const render = () => {
    if (i < top) top = i
    if (i >= top + pageSize) top = i - pageSize + 1
    const help = filterable ? "(↑/↓, type to filter, Enter)" : "(↑/↓, Enter)"
    const lines = [
      `${cyan("?")} ${bold(message)} ${query ? `${cyan(query)} ` : ""}${dim(help)}`,
      ...shown.slice(top, top + pageSize).map((c, k) => {
        const n = top + k
        const text = `${filterable ? "" : `${n + 1}. `}${c.label ?? c.value}${c.hint ? dim(`  ${c.hint}`) : ""}`
        return n === i ? cyan(`❯ ${text}`) : `  ${text}`
      }),
      ...(shown.length ? [] : [dim("  no matches")]),
      ...(shown.length > pageSize ? [dim(`  ${top + 1}–${Math.min(top + pageSize, shown.length)} of ${shown.length}`)] : []),
    ]
    write((drawn ? `\x1b[${drawn}A\r\x1b[0J` : HIDE_CURSOR) + lines.join("\n") + "\n")
    drawn = lines.length
  }
  render()
  const picked = await withRawKeys<T>((key) => {
    const up = key === "\x1b[A" || key === "\x1bOA" || (!filterable && key === "k")
    const down = key === "\x1b[B" || key === "\x1bOB" || key === "\t" || (!filterable && key === "j")
    if (key === "\r" || key === "\n") {
      if (shown[i]) return { done: shown[i]!.value }
      return undefined
    }
    if (up && shown.length) i = (i - 1 + shown.length) % shown.length
    else if (down && shown.length) i = (i + 1) % shown.length
    else if (filterable && (key === "\x7f" || key === "\b")) {
      query = query.slice(0, -1)
      refilter()
    } else if (filterable && key.length === 1 && key > " ") {
      query += key
      refilter()
    } else if (!filterable && /^[1-9]$/.test(key) && Number(key) <= choices.length) {
      i = Number(key) - 1
      render()
      return { done: choices[i]!.value }
    } else return undefined
    render()
    return undefined
  })
  const chosen = choices.find((c) => c.value === picked)!
  write(`\x1b[${drawn}A\r\x1b[0J${green("✔")} ${bold(message)} ${cyan(chosen.label ?? chosen.value)}\n`)
  return picked
}

/**
 * Line input. Enter on an empty line takes `def`; with no default an answer is
 * required. `validate` returns an error message to keep the prompt open.
 */
export async function input(message: string, opts: { def?: string; placeholder?: string; optional?: boolean; validate?: (v: string) => string | undefined } = {}): Promise<string> {
  let value = ""
  let error = ""
  let drawn = false
  const render = () => {
    const hint = opts.def ?? opts.placeholder ?? ""
    const shown = value || (hint ? dim(hint) : "")
    const line = `${cyan("?")} ${bold(message)} ${shown}${error ? `  ${paint("31")(error)}` : ""}`
    write(`${drawn ? "\r\x1b[0J" : ""}${line}`)
    // Park the cursor right after the typed text, not after the dimmed default or error.
    const tail = (value ? "" : hint).length + (error ? error.length + 2 : 0)
    if (tail) write(`\x1b[${tail}D`)
    drawn = true
  }
  render()
  const result = await withRawKeys<string>((key) => {
    if (key === "\r" || key === "\n") {
      const v = value.trim() || opts.def || ""
      const problem = !v ? (opts.optional ? undefined : "required") : opts.validate?.(v)
      if (!problem) return { done: v }
      error = problem
    } else if (key === "\x7f" || key === "\b") {
      value = [...value].slice(0, -1).join("")
      error = ""
    } else if (key === "\x15") {
      value = ""
      error = ""
    } else if (key.length === 1 ? key >= " " : !key.startsWith("\x1b")) {
      value += key
      error = ""
    } else return undefined
    render()
    return undefined
  })
  write(`\r\x1b[0J${green("✔")} ${bold(message)} ${result ? cyan(result) : dim(opts.placeholder ?? "skipped")}\n`)
  return result
}

/** Prints a settled answer in the same style as a completed prompt, for choices made without asking. */
export function answered(message: string, value: string): void {
  write(`${green("✔")} ${bold(message)} ${cyan(value)}\n`)
}

const nonNegative = (s: string) => (Number.isFinite(Number(s)) && Number(s) >= 0 ? undefined : "enter a non-negative number")

/** Number input that may be skipped with Enter; skipped (or 0) returns undefined. */
export async function optionalNumber(message: string, placeholder = "no cap"): Promise<number | undefined> {
  const v = await input(message, { placeholder, optional: true, validate: nonNegative })
  return v ? Number(v) || undefined : undefined
}

/** Free text in cooked mode, so long answers wrap and edit normally. Empty is allowed. */
export async function line(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(`${cyan("?")} ${bold(message)} `)).trim()
  } catch (e) {
    // Ctrl+C / Ctrl+D reject the question; exit like the other prompts instead of a stack trace.
    if ((e as Error).name === "AbortError") throw new CliError("aborted", undefined, 130)
    throw e
  } finally {
    rl.close()
  }
}

/** Shows a spinner on one line while `work` runs, then clears it. */
export async function spin<T>(message: string, work: Promise<T>): Promise<T> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let n = 0
  write(HIDE_CURSOR)
  const timer = setInterval(() => write(`\r${cyan(frames[n++ % frames.length]!)} ${message}`), 80)
  try {
    return await work
  } finally {
    clearInterval(timer)
    write(`\r\x1b[0J${SHOW_CURSOR}`)
  }
}

/*
 * Output gate: log lines printed while a prompt is on screen would break its in-place redraw, so
 * they wait until the prompt is done.
 */
let held: string[] | undefined

/** Prints a log line now, or after the current prompt if one is open. */
export function logLine(text: string): void {
  if (held) held.push(text)
  else write(text + "\n")
}

/** Runs a prompt with log output held back, then prints what arrived meanwhile. */
export async function withHeldOutput<T>(fn: () => Promise<T>): Promise<T> {
  held ??= []
  try {
    return await fn()
  } finally {
    const lines = held
    held = undefined
    for (const l of lines ?? []) write(l + "\n")
  }
}
