import { describe, expect, test } from "bun:test"
import { parseReviewerVerdict, parseVerdictLine, agentPermissionRules, reviewerPrompt, consultToolText } from "../src/opencode/plugin.ts"
import { loadCorePack } from "../src/engine/core-pack.ts"
import { READ_ONLY_RULES, permissionRules } from "../src/engine/prepare.ts"
import { loadPack } from "../src/pack/loader.ts"
import { referencePackDir } from "./helpers.ts"
import type { PermissionRule } from "../src/pack/schema.ts"
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
    // Reading, searching and loading skills never ask; then no nesting.
    expect(consultant.slice(0, 5).map((r) => `${r.action}:${r.effect}`)).toEqual(["read:allow", "glob:allow", "grep:allow", "list:allow", "skill:allow"])
    expect(consultant[READ_ONLY_RULES.length]).toEqual({ action: "subagent", resource: "*", effect: "deny" })
    // The consultant's shell deny comes after the read-only shell allows, so it wins.
    expect(consultant.findLastIndex((r) => r.action === "shell" && r.effect === "deny")).toBeGreaterThan(consultant.findLastIndex((r) => r.action === "shell" && r.effect === "allow"))
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

// OpenCode's evaluation: the last rule matching the action and resource wins; nothing matching asks.
const evaluate = (rules: PermissionRule[], action: string, resource: string) => {
  const glob = (p: string) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, action === "edit" ? "[^/]*" : ".*").replace(/\u0000/g, ".*") + "$", "s")
  return rules.findLast((r) => (r.action === action || r.action === "*") && glob(r.resource).test(resource))?.effect ?? "ask"
}

describe("developer agents", () => {
  test("the builder may edit the project and run anything, but not the pack's documents", async () => {
    const pack = await loadPack(referencePackDir())
    const step = { id: "build", type: "skill", skill: "work-on-task", by: "builder", writes: [] } as never
    const rules = permissionRules(pack.agents.builder!, ["**"], step, ["tasks/s1-t1/design-1/build-1.md"])
    for (const f of ["src/lib/i18n.ts", "public/audio/AUDIO_MANIFEST.json", "index.html", "tasks/s1-t1/design-1/build-1.md"]) expect(evaluate(rules, "edit", f)).toBe("allow")
    for (const f of ["specs/tech-spec.md", "stories/s1/tasks.yaml", "tasks/s1-t1/design-1/verdict-1.md", ".slate/state.json"]) expect(evaluate(rules, "edit", f)).toBe("deny")
    expect(evaluate(rules, "shell", "npm test")).toBe("allow")
    expect(evaluate(rules, "shell", "cat > /repo/specs/tech-spec.md << 'EOF'")).toBe("deny")
    expect(evaluate(rules, "shell", "cat > tasks/s1-t1/notes.md")).toBe("deny")
  })
})

describe("read-only shell commands", () => {
  const effect = (command: string) => evaluate(READ_ONLY_RULES, "shell", command)

  test("looking around goes through", () => {
    for (const c of ["wc -l stories/s2/TDD.md", "ls", "grep '^## ' stories/s2/TDD.md", "find src -type f", "git log --oneline -20", "which ffmpeg 2>/dev/null", "cat x 2>&1"])
      expect(effect(c)).toBe("allow")
  })

  test("anything that can change files still asks", () => {
    for (const c of ["cat > out.md << 'EOF'", "echo hi >> notes.md", "find . -name '*.tmp' -delete", "find . -exec rm {} ;", "cat x > y 2>/dev/null", "rm -rf src", "sed -i s/a/b/ f"])
      expect(effect(c)).toBe("ask")
  })
})
