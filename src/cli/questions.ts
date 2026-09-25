import path from "node:path"
import type { ProjectPaths } from "../config/paths.ts"
import type { Question } from "../engine/types.ts"
import { StateStore } from "../engine/state.ts"
import { ensureDir, writeJsonAtomic } from "../util/fs.ts"
import { CliError } from "./output.ts"
import { select, line, logLine, withHeldOutput } from "./prompt.ts"

/**
 * Answering questions from the terminal with a picker. Answers go through `.slate/answers/`, which
 * the engine watches, so the same picker works for an engine running in this process or another.
 */

/** Forms take any text; everything else must be one of its options (a note goes in the message). */
export function isValidAnswer(q: Question, option: string): boolean {
  return q.kind === "form" || !q.options.length || q.options.some((o) => o.id === option)
}

export async function deliverAnswer(paths: ProjectPaths, q: Question, answer: string, message?: string): Promise<void> {
  await ensureDir(paths.answers)
  await writeJsonAtomic(path.join(paths.answers, `${q.id}.json`), { answer, message, at: new Date().toISOString() })
}

export type Picked = { answer: string; message?: string } | "skip" | "quit"

/** Shows one question with its options, plus "answer later" and, when asked, "quit". */
export async function pickAnswer(q: Question, opts: { quit?: boolean } = {}): Promise<Picked> {
  const title = q.prompt.split("\n")[0]!.slice(0, 200)
  for (const c of q.context.slice(0, 1)) logLine(c.split("\n").slice(0, 8).join("\n"))
  if (q.kind === "form" || !q.options.length) {
    const text = await line(`${title}\n  (type the answer; Enter to skip)`)
    return text ? { answer: text } : "skip"
  }
  const choices = [
    ...q.options.map((o) => ({ value: `opt:${o.id}`, label: o.label || o.id, hint: o.default ? "default" : undefined })),
    { value: "skip", label: "answer later", hint: "slate inbox" },
    ...(opts.quit ? [{ value: "quit", label: "quit" }] : []),
  ]
  const picked = await select(title, choices, `opt:${(q.options.find((o) => o.default) ?? q.options[0])!.id}`)
  if (picked === "skip" || picked === "quit") return picked
  const answer = picked.slice(4)
  // A note is optional and only asked for when saying no: it is how a rejection explains itself.
  const wantsNote = q.freeText && /^(reject|no|deny|none)$/i.test(answer)
  const message = wantsNote ? (await line("note (optional, Enter to skip):")) || undefined : undefined
  return { answer, message }
}

/**
 * While attached to a job: asks each open question inline as it appears. Ctrl-C or "answer later"
 * leaves a question for `slate inbox`. Returns a function that stops watching.
 */
export function answerInline(paths: ProjectPaths): () => void {
  let stopped = false
  // Answered here or left for later; an answer stays "open" in state.json until the engine reads it.
  const handled = new Set<string>()
  void (async () => {
    while (!stopped) {
      const st = await StateStore.read(paths.state).catch(() => undefined)
      const q = st?.questions.find((x) => !x.answered && !handled.has(x.id))
      if (!q) {
        await Bun.sleep(500)
        continue
      }
      const picked = await withHeldOutput(() => pickAnswer(q)).catch((e) => {
        if (e instanceof CliError) return "skip" as const
        throw e
      })
      if (stopped) break
      handled.add(q.id)
      if (picked === "skip" || picked === "quit") {
        logLine(`  left ${q.id} for later: slate inbox`)
      } else {
        await deliverAnswer(paths, q, picked.answer, picked.message)
      }
    }
  })()
  return () => {
    stopped = true
  }
}
