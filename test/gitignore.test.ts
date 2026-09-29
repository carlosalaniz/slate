import { describe, expect, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { ensureGitignore } from "../src/config/gitignore.ts"
import { tmpProject } from "./helpers.ts"

describe("gitignore", () => {
  test("appends Slate's block once, after what is already there", async () => {
    const root = await tmpProject()
    const file = path.join(root, ".gitignore")
    await writeFile(file, "node_modules/")
    expect(await ensureGitignore(root)).toBe(true)
    expect(await ensureGitignore(root)).toBe(false)
    const text = await Bun.file(file).text()
    expect(text.startsWith("node_modules/\n\n# Slate")).toBe(true)
    expect(text.match(/# Slate/g)!.length).toBe(1)
    expect(text).toContain("!.slate/brief.md")
  })

  test("git ignores runtime files but keeps the brief", async () => {
    const root = await tmpProject()
    await ensureGitignore(root)
    Bun.spawnSync(["git", "init", "-q"], { cwd: root })
    const ignored = (f: string) => Bun.spawnSync(["git", "check-ignore", "-q", f], { cwd: root }).exitCode === 0
    expect(ignored(".slate/state.json")).toBe(true)
    expect(ignored(".slate/opencode.db")).toBe(true)
    expect(ignored(".opencode/agents/slate-discovery.md")).toBe(true)
    expect(ignored(".slate/brief.md")).toBe(false)
    expect(ignored(".slate/installed/lock.yaml")).toBe(false)
    expect(ignored(".slate/installed/skills/tts/SKILL.md")).toBe(false)
    expect(ignored("slate.config.yml")).toBe(false)
  })

  test("a block from an older Slate gets the lines it lacks", async () => {
    const root = await tmpProject()
    const file = path.join(root, ".gitignore")
    await writeFile(file, "dist/\n\n# Slate (added by slate init)\n.slate/*\n!.slate/brief.md\n!.slate/plan-revisions.md\n.opencode/agents/slate-*.md\n\n# mine\n*.log\n")
    expect(await ensureGitignore(root)).toBe(true)
    expect(await ensureGitignore(root)).toBe(false)
    const text = await Bun.file(file).text()
    expect(text).toContain(".opencode/agents/slate-*.md\n!.slate/installed/\n\n# mine")
  })
})
