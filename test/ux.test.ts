import { describe, expect, test } from "bun:test"
import path from "node:path"
import { existsSync, readdirSync } from "node:fs"
import { referencePackDir, tmpProject } from "./helpers.ts"

const scriptsDir = path.join(referencePackDir(), "scripts", "scripts")
const run = (root: string, script: string, args: string[], env: Record<string, string> = {}) => {
  const r = Bun.spawnSync([process.execPath, path.join(scriptsDir, `${script}.ts`), ...args], { cwd: root, env: { ...process.env, SLATE_WORKSPACE: root, ...env } })
  if (r.exitCode !== 0) throw new Error(`${script} exited ${r.exitCode}: ${r.stderr.toString()}`)
  return JSON.parse(r.stdout.toString().trim().split("\n").pop()!)
}
const write = async (root: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) await Bun.write(path.join(root, rel), text)
}
const git = (root: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
const gitRepo = async (root: string) => {
  git(root, "init", "-q", "-b", "main")
  git(root, "add", "-A")
  git(root, "commit", "-qm", "init")
}

const INDEX = `stories:
  - id: s1
    title: Menu
    screens: ["/"]
  - id: s2
    title: Storage
    screens: []
  - id: s3
    title: Settings
    screens: ["/settings"]
`

describe("next-ux-review", () => {
  test("hands out landed stories with screens, once, within the passes", async () => {
    const root = await tmpProject()
    await write(root, { "stories/index.yaml": INDEX, "stories/s1/merged.md": "x", "stories/s2/merged.md": "x" })
    expect(run(root, "next-ux-review", ["2"])).toEqual({ next: "s1" })
    // s2 has no screens, s3 has not landed
    expect(run(root, "next-ux-review", ["2"], { SLATE_CLAIMED: '["s1"]' })).toEqual({ done: true })
    await write(root, { "stories/s3/merged.md": "x" })
    expect(run(root, "next-ux-review", ["2"], { SLATE_CLAIMED: '["s1"]' })).toEqual({ next: "s3" })
    // a fix story from a pass-2 review is past the limit of 2
    await write(root, { "stories/index.yaml": `${INDEX}  - id: s1-ux2\n    screens: ["/"]\n    ux_of: s1\n    ux_pass: 2\n`, "stories/s1-ux2/merged.md": "x" })
    expect(run(root, "next-ux-review", ["2"], { SLATE_CLAIMED: '["s1","s3"]' })).toEqual({ done: true })
  })

  test("is off with 0 passes, with playwright waived, or when the app has no screens", async () => {
    const root = await tmpProject()
    await write(root, { "stories/index.yaml": INDEX, "stories/s1/merged.md": "x" })
    expect(run(root, "next-ux-review", ["0"])).toMatchObject({ done: true })
    expect(run(root, "next-ux-review", ["2"], { SLATE_VAR_WAIVED: "image-input,playwright" })).toMatchObject({ done: true, note: "UX review is off: playwright is waived" })
    await write(root, { "specs/tech-spec.md": "serve command: `none`\n" })
    expect(run(root, "next-ux-review", ["2"])).toMatchObject({ done: true, note: "the app has no screens to serve" })
  })
})

describe("file-ux-fixes", () => {
  const review = `verdict: fail
issues:
  - screen: /
    viewport: 390x844
    problem: The Play label spills out of its button.
    expected: The label fits inside the button.
    severity: must-fix
  - screen: /
    viewport: all
    problem: The title could be warmer.
    severity: nice-to-have
`

  test("must-fix issues become one fix story that depends on the reviewed story, committed", async () => {
    const root = await tmpProject()
    await write(root, { "stories/index.yaml": INDEX, "stories/graph.yaml": "nodes:\n  s1: []\n  s2: [s1]\n  s3: [s1]\n", "stories/s1/merged.md": "x" })
    await gitRepo(root)
    await write(root, { "stories/s1/ux-review.yaml": review })
    expect(run(root, "file-ux-fixes", ["s1"])).toEqual({ ok: true, filed: "s1-ux1", issues: 1, nice_to_have: 1 })
    const index = Bun.YAML.parse(await Bun.file(path.join(root, "stories/index.yaml")).text()) as { stories: Record<string, unknown>[] }
    const fix = index.stories.find((s) => s.id === "s1-ux1")!
    expect(fix).toMatchObject({ depends_on: ["s1"], screens: ["/"], ux_of: "s1", ux_pass: 1, acceptance: ["/ at 390x844: The label fits inside the button."] })
    expect(String(fix.description)).toContain("The Play label spills out of its button.")
    expect(String(fix.description)).not.toContain("warmer")
    expect((Bun.YAML.parse(await Bun.file(path.join(root, "stories/graph.yaml")).text()) as { nodes: Record<string, string[]> }).nodes["s1-ux1"]).toEqual(["s1"])
    expect(git(root, "log", "-1", "--format=%s").stdout.toString().trim()).toBe("UX review of s1: file s1-ux1")
    expect(git(root, "status", "--porcelain").stdout.toString().trim()).toBe("")
    // A fix story's own review files the next pass, rooted at the original story.
    await write(root, { "stories/s1-ux1/ux-review.yaml": review.replace("verdict: fail", "verdict: fail") })
    expect(run(root, "file-ux-fixes", ["s1-ux1"])).toMatchObject({ ok: true, filed: "s1-ux2" })
  })

  test("nothing must change: no story; a fail verdict without issues is a failed check", async () => {
    const root = await tmpProject()
    await write(root, { "stories/index.yaml": INDEX, "stories/s1/ux-review.yaml": "verdict: pass\nissues: []\n" })
    expect(run(root, "file-ux-fixes", ["s1"])).toMatchObject({ ok: true, filed: null })
    await write(root, { "stories/s1/ux-review.yaml": "verdict: fail\nissues: []\n" })
    expect(run(root, "file-ux-fixes", ["s1"])).toMatchObject({ ok: false })
  })
})

describe("check-placeholders", () => {
  const report = "---\nplaceholders:\n  - path: public/audio/**/*.mp3\n    stands_in_for: spoken clips\n---\n# build\n"

  test("stand-ins nothing replaced halt the job; replacing them clears it; report mode lets them ship", async () => {
    const root = await tmpProject()
    await write(root, { "tasks/s2-t4/design-1/build-1.md": report, "public/audio/en/one.mp3": "silence", "public/audio/es/uno.mp3": "silence" })
    await gitRepo(root)
    const halted = run(root, "check-placeholders", ["halt"])
    expect(halted).toMatchObject({ ok: false, halt: true })
    expect(halted.reason).toContain("public/audio/**/*.mp3 (2, for spoken clips)")
    expect(await Bun.file(path.join(root, "stories/placeholders.md")).text()).toContain("stands in for spoken clips")
    expect(run(root, "check-placeholders", ["report"])).toMatchObject({ ok: true, placeholders: 1 })
    await write(root, { "public/audio/en/one.mp3": "real speech", "public/audio/es/uno.mp3": "voz real" })
    git(root, "commit", "-qam", "real audio")
    expect(run(root, "check-placeholders", ["halt"])).toEqual({ ok: true, placeholders: 0 })
    expect(existsSync(path.join(root, "stories/placeholders.md"))).toBe(false)
  })

  test("only the latest build report of a task counts", async () => {
    const root = await tmpProject()
    await write(root, { "tasks/s1-t1/design-1/build-1.md": report, "tasks/s1-t1/design-1/build-2.md": "# no stand-ins now\n", "public/audio/en/one.mp3": "x" })
    expect(run(root, "check-placeholders", ["halt"])).toEqual({ ok: true, placeholders: 0 })
  })
})

describe("ux-screenshots (real browser)", () => {
  test("screenshots every screen at every viewport and measures overflowing text and small targets", async () => {
    const root = await tmpProject()
    const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;font:16px sans-serif">
      <button style="width:60px;height:30px;white-space:nowrap;overflow:visible">Play the counting game</button>
      <div style="width:900px">wide</div></body></html>`
    await write(root, { "index.html": page, "stories/index.yaml": INDEX })
    const r = run(root, "ux-screenshots", ["s1", "320x568,768x1024", "6", "44"])
    expect(r).toMatchObject({ ok: true, screenshots: 2 })
    const dir = path.join(root, "stories/s1/ux")
    expect(readdirSync(dir).filter((f) => f.endsWith(".png")).sort()).toEqual(["01-home@320x568.png", "01-home@768x1024.png"])
    const findings = await Bun.file(path.join(dir, "findings.md")).text()
    expect(findings).toContain("/ @ 320x568: page is")
    expect(findings).toContain('<button> "Play the counting game" is 60x30px, under the 44px touch target')
    expect(findings).toMatch(/text of <button> "Play the counting game" is \d+px wider than its \d+px box \(spills out\)/)
    expect(await Bun.file(path.join(dir, ".gitignore")).text()).toBe("*\n")
  }, 60_000)
})
