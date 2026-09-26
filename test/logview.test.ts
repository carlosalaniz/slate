import { describe, expect, test } from "bun:test"
import { LogView } from "../src/cli/logview.ts"
import type { AuditEvent } from "../src/engine/types.ts"

const at = (s: string) => `2026-09-26T${s}.000Z`
const rec = (time: string, event: AuditEvent) => ({ at: at(time), event })
const key = "build/story-loop[0]/design{2}/tdd{1}/write-tdd"

describe("log view", () => {
  test("agent first, auto-approved permissions on one line, consults nested, story as a tag", () => {
    const view = new LogView()
    const lines = view.events([
      rec("01:42:50", { type: "loop.iteration", key: "build/story-loop", loop: "story-loop", iteration: 0, value: "s1" }),
      rec("01:42:55", { type: "loop.round", key: "build/story-loop[0]/design", loop: "build/story-loop[0]/design", round: 2, max: 2 }),
      rec("01:42:55", { type: "step.start", key, step: "write-tdd", branch: "story:s1", agent: "architect", vars: { story: "s1" } }),
      rec("01:43:01", { type: "question.open", id: "q1", kind: "permission", branch: "story:s1", prompt: "Agent architect in write-tdd asks permission: glob tasks/**/design-1/verdict-*.md", key }),
      rec("01:43:01", { type: "question.answered", id: "q1", answer: "once" }),
      rec("01:43:09", { type: "consult", key, step: "write-tdd", consultant: "product-owner-consultant", n: 1, verdict: "pass", file: "consults/write-tdd/1.md" }),
      rec("01:43:12", { type: "step.end", key, step: "write-tdd", branch: "story:s1", status: "passed", cost: 0.012 }),
    ])
    expect(lines.map((l) => l.replace(/\s+/g, " "))).toEqual([
      "01:42:50 slate story-loop → s1 · s1",
      "01:42:55 slate design round 2/2 · s1",
      "01:42:55 architect starts write-tdd · s1",
      "01:43:01 architect permission glob tasks/**/design-1/verdict-*.md → once · s1",
      "01:43:09 architect › product-owner-consultant answered consult #1: pass · s1",
      "01:43:12 architect write-tdd passed $0.012 · s1",
    ])
  })

  test("permissions the job's autonomy allowed stay out of the log; rejections show", () => {
    const view = new LogView()
    const lines = view.events([
      rec("02:48:40", { type: "step.start", key, step: "write-tdd", branch: "story:s2", agent: "architect", vars: { story: "s2" } }),
      rec("02:48:42", { type: "question.open", id: "q3", kind: "permission", branch: "story:s2", prompt: "Agent architect in write-tdd asks permission: shell ls -la tasks/", key }),
      rec("02:48:42", { type: "question.answered", id: "q3", answer: "once", by: "policy" }),
      rec("02:48:43", { type: "question.open", id: "q4", kind: "permission", branch: "story:s2", prompt: "Agent architect in write-tdd asks permission: shell git push", key }),
      rec("02:48:50", { type: "question.answered", id: "q4", answer: "reject", by: "human" }),
    ])
    expect(lines.map((l) => l.replace(/\s+/g, " "))).toEqual(["02:48:40 architect starts write-tdd · s2", "02:48:50 architect permission shell git push → reject · s2"])
    expect(view.events([])).toEqual([])
  })

  test("a nested loop is tagged with its innermost item", () => {
    const view = new LogView()
    const lines = view.events([
      rec("01:47:10", { type: "loop.iteration", key: "build/story-loop", loop: "story-loop", iteration: 0, value: "s1" }),
      rec("01:47:12", { type: "loop.iteration", key: "build/story-loop[0]/design{2}/task-loop", loop: "task-loop", iteration: 0, value: "s1-t1" }),
      rec("01:47:12", { type: "loop.round", key: "build/story-loop[0]/design{2}/task-loop[0]/build-verify", loop: "build-verify", round: 1, max: 3 }),
    ])
    expect(lines[2]!.replace(/\s+/g, " ")).toBe("01:47:12 slate build-verify round 1/3 · s1-t1")
  })

  test("a permission nobody answered yet shows as waiting on you", () => {
    const view = new LogView()
    view.events([rec("01:43:00", { type: "step.start", key, step: "write-tdd", branch: "story:s1", agent: "architect", vars: { story: "s1" } })])
    expect(view.events([rec("01:43:04", { type: "question.open", id: "q2", kind: "permission", branch: "story:s1", prompt: "Agent architect in write-tdd asks permission: shell npm test", key })])).toEqual([])
    // Still open on the next read: it really waits on a person.
    const lines = view.events([])
    expect(lines[0]!.replace(/\s+/g, " ")).toBe("01:43:04 architect waiting on you: permission shell npm test [q2] · s1")
  })

  test("live actions nest subagents under the agent that started them, once per change", () => {
    const view = new LogView()
    const file = {
      updated: at("01:43:05"),
      sessions: {
        a: { sessionID: "a", key, agent: "architect", action: "read specs/tech-spec.md", since: at("01:43:05"), log: "s1" },
        c: { sessionID: "c", key, agent: "staff-engineer", parent: "a", action: "thinking", since: at("01:43:06"), log: "s1" },
      },
    }
    expect(view.activity(file).map((l) => l.replace(/\s+/g, " "))).toEqual(["01:43:05 architect read specs/tech-spec.md · s1"])
    file.sessions.c.action = "grep TODO"
    expect(view.activity(file).map((l) => l.replace(/\s+/g, " "))).toEqual(["01:43:06 architect › staff-engineer grep TODO · s1"])
    expect(view.activity(file)).toEqual([])
  })
})
