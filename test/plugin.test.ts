import { describe, expect, test } from "bun:test"
import { parseReviewerVerdict, parseVerdictLine, agentPermissionRules, reviewerPrompt, consultToolText } from "../src/opencode/plugin.ts"
import { loadCorePack } from "../src/engine/core-pack.ts"
import { parseArgs, str, bool, num } from "../src/cli/args.ts"

describe("plugin helpers", () => {
  test("reviewer verdicts require a citation to approve", () => {
    expect(parseReviewerVerdict("decision: approve\ncite: specs/tech-spec.md:12\nnote: listed")).toEqual({ decision: "approve", cite: "specs/tech-spec.md:12", note: "listed" })
    expect(parseReviewerVerdict("decision: reject\nnote: not in spec").decision).toBe("reject")
    expect(parseReviewerVerdict("I think it's fine").decision).toBe("escalate")
  })

  test("consult verdict line", () => {
    expect(parseVerdictLine("Use a queue.\n\nverdict: approve")).toBe("approve")
    expect(parseVerdictLine("Verdict: Revise\n")).toBe("revise")
    expect(parseVerdictLine("no verdict here")).toBeUndefined()
  })

  test("agent rules: consultants cannot edit or shell; workers get scope allows after a deny-all", () => {
    const consultant = agentPermissionRules({ id: "c", description: "", role: "consultant", model: "high", scope: { read: ["**"] }, permissions: [], prompt: "" })
    expect(consultant.some((r) => r.action === "edit" && r.resource === "*" && r.effect === "deny")).toBe(true)
    expect(consultant.some((r) => r.action === "shell" && r.effect === "deny")).toBe(true)
    expect(consultant[0]).toEqual({ action: "subagent", resource: "*", effect: "deny" })
    const worker = agentPermissionRules({ id: "w", description: "", role: "worker", model: "low", scope: { modify: ["src/**"] }, permissions: [{ action: "shell", resource: "git push *", effect: "ask" }], prompt: "" })
    const denyIdx = worker.findIndex((r) => r.action === "edit" && r.resource === "*")
    const allowIdx = worker.findIndex((r) => r.action === "edit" && r.resource === "src/**")
    expect(denyIdx).toBeLessThan(allowIdx)
    expect(worker[worker.length - 1]).toEqual({ action: "shell", resource: "git push *", effect: "ask" })
  })

  test("reviewer prompt includes inputs and the answer format", async () => {
    const core = await loadCorePack()
    const p = reviewerPrompt(core, { id: "po", description: "", role: "reviewer", model: "low", scope: {}, permissions: [], prompt: "You are PO." }, "shell", ["npm install left-pad"], [{ path: "specs/tech-spec.md", content: "deps: none" }])
    expect(p).toContain("You are PO.")
    expect(p).toContain("npm install left-pad")
    expect(p).toContain("=== specs/tech-spec.md ===")
    expect(p).toContain("decision: approve | reject | escalate")
  })

  test("the consult tool's description and argument help come from slate-core", async () => {
    const t = consultToolText(await loadCorePack())
    expect(t.description).toStartWith("Ask a named consultant agent one question.")
    expect(t.agent).toContain("Consultant agent id")
    expect(t.question).toContain("enough context")
  })
})

describe("args", () => {
  test("parses commands, flags and positionals", () => {
    const a = parseArgs(["inbox", "--answer", "q1", "approve", "--message=looks good", "--json", "-y", "--no-color"])
    expect(a.command).toBe("inbox")
    expect(a.positional).toEqual(["approve"])
    expect(str(a.flags, "answer")).toBe("q1")
    expect(str(a.flags, "message")).toBe("looks good")
    expect(bool(a.flags, "json")).toBe(true)
    expect(bool(a.flags, "yes", "y")).toBe(true)
    expect(a.flags["color"]).toBe(false)
    expect(num(parseArgs(["x", "--tail", "5"]).flags, "tail")).toBe(5)
  })
})
