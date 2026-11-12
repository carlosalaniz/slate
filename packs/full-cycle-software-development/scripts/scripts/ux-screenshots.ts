/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Takes the screenshots a UX review looks at, and measures what a machine can measure, for one
 * landed story: every screen the story lists (`screens:` in stories/index.yaml), at every viewport.
 *
 * It serves the project's current branch from a throwaway detached worktree (so stories landing
 * meanwhile cannot change the files under the server), with the project's node_modules linked in.
 * The serve command comes from specs/tech-spec.md (a line like "serve command: `npm run dev --
 * --port {port}`"), else `npm run dev -- --port {port}` when package.json has a dev script, else a
 * static server over index.html.
 *
 * Output, in stories/<story>/ux/ (ignored by git): `<n>-<screen>@<w>x<h>.png` and findings.md, the
 * measured layout problems: text that overflows its element, controls that overlap, touch targets
 * smaller than the minimum, anything wider than the viewport. An app that cannot be served or
 * rendered fails the check with the reason.
 */
import fs from "node:fs"
import path from "node:path"
import { workspace, reply, broken, git, readYaml, type StoryIndex } from "./lib.ts"

const [story, viewportArg = "320x568,390x844,768x1024", maxArg = "6", minTargetArg = "44"] = process.argv.slice(2)
if (!story) broken("usage: ux-screenshots <story> [viewports] [max screens] [min target px]")

const entry = readYaml<StoryIndex>("stories/index.yaml")?.stories?.find((s) => String(s.id) === story)
if (!entry) broken(`story ${story} is not in stories/index.yaml`)
const screens = (entry.screens ?? []).map(String).slice(0, Number(maxArg) || 6)
const viewports = viewportArg
  .split(",")
  .map((v) => v.trim().split("x").map(Number))
  .filter(([w, h]) => w! > 0 && h! > 0) as [number, number][]
const minTarget = Number(minTargetArg) || 44
if (!screens.length) reply({ ok: true, note: `story ${story} lists no screens` })

const out = path.join(workspace, "stories", story, "ux")
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, ".gitignore"), "*\n")

const { chromium } = await loadPlaywright()
const site = checkout()
const port = await freePort()
const server = serve(site.dir, port)
try {
  const base = `http://localhost:${port}`
  const up = await waitFor(base, 90_000)
  if (!up.ok) fail(`the app did not come up at ${base} with \`${server.command}\` within 90s: ${up.reason}${server.output() ? `\n${server.output().slice(-1500)}` : ""}`)
  const browser = await chromium.launch({ headless: true })
  const findings: string[] = []
  const shots: string[] = []
  try {
    for (const [i, screen] of screens.entries()) {
      for (const [w, h] of viewports) {
        const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: w < 900, isMobile: w < 900 })
        const errors: string[] = []
        page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]!))
        const url = new URL(screen, base).toString()
        const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch((e: Error) => e)
        const where = `${screen} @ ${w}x${h}`
        if (res instanceof Error) {
          findings.push(`- ${where}: could not load (${res.message.split("\n")[0]})`)
          await page.close()
          continue
        }
        await page.waitForTimeout(300)
        const file = `${String(i + 1).padStart(2, "0")}-${slug(screen)}@${w}x${h}.png`
        await page.screenshot({ path: path.join(out, file), fullPage: true })
        shots.push(file)
        if (res && res.status() >= 400) findings.push(`- ${where}: HTTP ${res.status()}`)
        for (const e of errors.slice(0, 3)) findings.push(`- ${where}: page error: ${e}`)
        for (const f of await page.evaluate(measure, { minTarget })) findings.push(`- ${where}: ${f}`)
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  const header = [`# Measured layout problems: ${story}`, "", `Screens: ${screens.join(", ")}. Viewports: ${viewports.map(([w, h]) => `${w}x${h}`).join(", ")}. Minimum touch target: ${minTarget}px.`, ""]
  fs.writeFileSync(path.join(out, "findings.md"), [...header, ...(findings.length ? findings : ["None found."]), ""].join("\n"))
  reply({ ok: true, screenshots: shots.length, findings: findings.length, dir: path.relative(workspace, out) })
} finally {
  server.stop()
  site.remove()
}

/* ------------------------------------------------------------------------------------------ */

function fail(reason: string): never {
  server?.stop()
  site?.remove()
  reply({ ok: false, reason })
}

/** Runs in the page: what is measurably wrong with the layout, one line each. */
function measure({ minTarget }: { minTarget: number }): string[] {
  const out: string[] = []
  const vw = document.documentElement.clientWidth
  const label = (el: Element) => {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)
    const aria = el.getAttribute("aria-label")
    return `<${el.tagName.toLowerCase()}>${aria ? ` "${aria}"` : text ? ` "${text}"` : ""}`
  }
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0
  }
  if (document.documentElement.scrollWidth > vw + 1) out.push(`page is ${document.documentElement.scrollWidth}px wide, wider than the ${vw}px viewport (horizontal scroll)`)
  const controls = [...document.querySelectorAll("button, a[href], [role=button], input, select, textarea, [role=tab], [role=switch]")].filter(visible)
  for (const el of controls) {
    const r = el.getBoundingClientRect()
    if (r.right > vw + 1 || r.left < -1) out.push(`${label(el)} sticks out of the viewport (x ${Math.round(r.left)} to ${Math.round(r.right)})`)
    if (r.width < minTarget || r.height < minTarget) out.push(`${label(el)} is ${Math.round(r.width)}x${Math.round(r.height)}px, under the ${minTarget}px touch target`)
  }
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!
      const b = controls[j]!
      if (a.contains(b) || b.contains(a)) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (x > 2 && y > 2) out.push(`${label(a)} and ${label(b)} overlap by ${Math.round(x)}x${Math.round(y)}px`)
    }
  }
  // Text wider or taller than the box it sits in: clipped, or spilling out of a button.
  const boxes = [...document.querySelectorAll("button, a, [role=button], label, h1, h2, h3, h4, p, span, li, td, th, div")].filter(visible)
  for (const el of boxes) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim())
    if (!hasText) continue
    const over = el.scrollWidth - el.clientWidth
    const overY = el.scrollHeight - el.clientHeight
    const s = getComputedStyle(el)
    if (el.clientWidth > 0 && over > 1 && s.overflowX !== "auto" && s.overflowX !== "scroll") out.push(`text of ${label(el)} is ${over}px wider than its ${el.clientWidth}px box${s.overflowX === "hidden" ? " (clipped)" : " (spills out)"}`)
    else if (el.clientHeight > 0 && overY > 1 && s.overflowY !== "auto" && s.overflowY !== "scroll" && s.height !== "auto" && /^(button|a)$/i.test(el.tagName)) out.push(`text of ${label(el)} is ${overY}px taller than its ${el.clientHeight}px box`)
  }
  return [...new Set(out)].slice(0, 40)
}

/** Playwright installed at or above `from`. Only installed copies: resolving from a directory with no
 * node_modules makes Bun auto-install the latest release, whose browser build is not downloaded. */
function installedPlaywright(from: string): string | undefined {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node_modules", "playwright", "package.json"))) return Bun.resolveSync("playwright", dir)
    if (path.dirname(dir) === dir) return undefined
  }
}

async function loadPlaywright(): Promise<typeof import("playwright")> {
  for (const from of [workspace, import.meta.dir]) {
    const entry = installedPlaywright(from)
    if (entry) return (await import(entry)) as typeof import("playwright")
  }
  return broken("playwright is not installed; `slate check` says how to install it")
}

/** A detached worktree of the project's HEAD with its node_modules linked in; the project itself outside git. */
function checkout(): { dir: string; remove: () => void } {
  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) return { dir: workspace, remove: () => undefined }
  const dir = path.join(workspace, ".slate", "ux", story!)
  git(["worktree", "remove", "--force", dir])
  fs.rmSync(dir, { recursive: true, force: true })
  const add = git(["worktree", "add", "--detach", dir, "HEAD"])
  if (!add.ok) broken(`git worktree add failed: ${add.err}`)
  const modules = path.join(workspace, "node_modules")
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(dir, "node_modules"), "dir")
  return {
    dir,
    remove: () => {
      git(["worktree", "remove", "--force", dir])
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function serve(dir: string, port: number): { command: string; stop: () => void; output: () => string } {
  const spec = path.join(dir, "specs", "tech-spec.md")
  const fromSpec = fs.existsSync(spec) ? /serve command[^`\n]*`([^`]+)`/i.exec(fs.readFileSync(spec, "utf8"))?.[1] : undefined
  const pkg = path.join(dir, "package.json")
  const dev = fs.existsSync(pkg) && Boolean((JSON.parse(fs.readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts?.dev)
  const template = fromSpec ?? (dev ? "npm run dev -- --port {port} --strictPort" : undefined)
  if (!template) {
    if (!fs.existsSync(path.join(dir, "index.html"))) broken("no way to serve the app: add a line like 'serve command: `npm run dev -- --port {port}`' to specs/tech-spec.md")
    const server = Bun.serve({
      port,
      fetch(req) {
        const p = decodeURIComponent(new URL(req.url).pathname)
        const file = path.join(dir, p)
        if (file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile()) return new Response(Bun.file(file))
        return new Response(Bun.file(path.join(dir, "index.html")))
      },
    })
    return { command: "static server over index.html", stop: () => server.stop(true), output: () => "" }
  }
  const command = template.replaceAll("{port}", String(port))
  let log = ""
  const proc = Bun.spawn(["sh", "-c", command], { cwd: dir, env: { ...process.env, PORT: String(port), BROWSER: "none", CI: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true })
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const reader = stream.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        log = (log + new TextDecoder().decode(value)).slice(-4000)
      }
    })()
  }
  return {
    command,
    output: () => log,
    stop: () => {
      try {
        process.kill(-proc.pid, "SIGTERM")
      } catch {
        proc.kill()
      }
    },
  }
}

async function waitFor(url: string, ms: number): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + ms
  let reason = "no answer"
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (r.status < 500) return { ok: true }
      reason = `HTTP ${r.status}`
    } catch (e) {
      reason = (e as Error).message
    }
    await Bun.sleep(500)
  }
  return { ok: false, reason }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = s.port!
  s.stop(true)
  return port
}

function slug(screen: string): string {
  return screen.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40) || "home"
}
