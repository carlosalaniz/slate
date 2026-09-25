import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ActivityTracker, activityLines, describeTool, type ActivityFile } from "../src/opencode/activity.ts"
import { tmpProject } from "./helpers.ts"

const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

describe("agent activity", () => {
  test("tool calls read as short actions", () => {
    expect(describeTool("shell", { command: "npm test\n--silent" }, "/w")).toBe("shell: npm test")
    expect(describeTool("edit", { path: "/w/src/game.ts" }, "/w")).toBe("edit src/game.ts")
    expect(describeTool("subagent", { agent: "explore", description: "find tests" }, "/w")).toBe("subagent explore: find tests")
    expect(describeTool("question", {}, "/w")).toBe("asking you")
  })

  test("status shows the step agent, its consult and the consult's subagent as a tree", async () => {
    const root = await tmpProject()
    const file = path.join(root, ".slate/activity.json")
    const t = new ActivityTracker(file, root)
    t.register({ sessionID: "s1", key: "build/.../verify", agent: "checker", log: "s1-t1" })
    t.register({ sessionID: "c1", key: "build/.../verify/consult#1", agent: "staff-engineer", parent: "s1", log: "s1-t1" })
    t.handle(ev("session.created", { sessionID: "g1", parentID: "c1", agent: "explore" }))
    t.handle(ev("session.tool.input.started", { sessionID: "s1", id: "t1", name: "shell" }))
    t.handle(ev("session.tool.called", { sessionID: "s1", id: "t1", input: { command: "npm test" } }))
    t.handle(ev("session.reasoning.started", { sessionID: "c1" }))
    t.handle(ev("session.tool.input.started", { sessionID: "g1", id: "t2", name: "read" }))
    t.handle(ev("session.tool.called", { sessionID: "g1", id: "t2", input: { path: path.join(root, "specs/tech-spec.md") } }))
    t.handle(ev("session.tool.called", { sessionID: "unrelated", id: "x", input: {} }))
    await Bun.sleep(700)
    const a = JSON.parse(await Bun.file(file).text()) as ActivityFile
    expect(activityLines(a, () => "3s")).toEqual([
      "  checker · shell: npm test · 3s · slate log s1-t1",
      "    └ staff-engineer · thinking · 3s · slate log s1-t1",
      "      └ explore · read specs/tech-spec.md · 3s · slate log s1-t1",
    ])
    // When the step ends, its whole tree leaves the status.
    t.end("s1")
    await Bun.sleep(700)
    expect(activityLines(JSON.parse(await Bun.file(file).text()), () => "3s")).toEqual([])
  })
})
