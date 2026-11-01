import { describe, expect, test, afterAll } from "bun:test"
import path from "node:path"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import YAML from "yaml"
import { harness, referencePackDir, tmpProject, testConfig } from "./helpers.ts"
import { fetchSkill, installSkill, installTool, mapNeed, searchSkills, searchTools, secretsRead, serviceOf, setupCommands, setupSteps, skillCommands, toolId } from "../src/marketplace/marketplace.ts"
import { loadPack, readLock } from "../src/pack/loader.ts"
import { saveProjectConfig } from "../src/config/project.ts"

/** A stand-in for skills.sh and the MCP Registry. */
const api = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/search") return Response.json({ skills: [{ source: "acme/voice", skillId: "tts", name: "tts", installs: 42 }] })
    if (url.pathname === "/v0/servers") {
      const pkg = (version: string) => ({ registryType: "npm", identifier: "@acme/mcp-server-voice", version, transport: { type: "stdio" }, environmentVariables: [{ name: "ACME_API_KEY", isRequired: true, description: "key" }, { name: "ACME_REGION" }] })
      return Response.json({
        servers: [
          { server: { name: "io.github.acme/mcp-server-voice", version: "1.0.0", packages: [pkg("1.0.0")] }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
          { server: { name: "io.github.acme/mcp-server-voice", version: "1.1.0", description: "Speech", packages: [pkg("1.1.0")] }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } } },
          { server: { name: "com.remote/only", version: "1.0.0" }, _meta: {} },
        ],
      })
    }
    return new Response("no", { status: 404 })
  },
})
afterAll(() => api.stop(true))
const base = `http://localhost:${api.port}`

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })

/** A repository holding one standard skill folder, like the ones skills.sh indexes. */
async function skillRepo(): Promise<string> {
  const repo = await tmpProject()
  const skill = path.join(repo, "skills", "tts")
  await mkdir(path.join(skill, "scripts"), { recursive: true })
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: tts\ndescription: Speak text with Acme.\ncompatibility: Needs an Acme key.\nmetadata: {\"openclaw\": {\"requires\": {\"env\": [\"ACME_API_KEY\"]}}}\n---\n\n# Acme TTS\n\nconst key = process.env.ACME_EXTRA_TOKEN\n")
  await writeFile(path.join(skill, "scripts", "speak.sh"), "#!/bin/sh\necho hi\n")
  await mkdir(path.join(repo, "skills", "music"), { recursive: true })
  await writeFile(path.join(repo, "skills", "music", "SKILL.md"), "---\nname: music\ndescription: Songs through the Acme CLI.\nhomepage: https://www.acme-music.com\nallowed-tools: Bash(acmemusic *)\n---\n\n```bash\nnpm i -g @acmemusic/cli\nacmemusic login\nacmemusic run song\n```\n")
  git(repo, "init", "-q", "-b", "main")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "skill")
  return repo
}

describe("marketplace search", () => {
  test("skills come back as source + id; tools as the latest local package with its command and keys", async () => {
    expect(await searchSkills(base, "speech")).toEqual([{ kind: "skill", source: "acme/voice", skillId: "tts", name: "tts", installs: 42 }])
    const tools = await searchTools(base, "voice")
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: "io.github.acme/mcp-server-voice", version: "1.1.0", command: ["npx", "-y", "@acme/mcp-server-voice@1.1.0"], env: ["ACME_API_KEY"] })
    expect(toolId(tools[0]!.name)).toBe("voice")
  })

  test("the service a skill works through and the setup it asks for are found", () => {
    expect(serviceOf("https://www.runcomfy.com", [])).toBe("runcomfy.com")
    expect(serviceOf(undefined, ["see https://docs.deepgram.com/a, https://api.deepgram.com/v1 and https://github.com/x/y"])).toBe("deepgram.com")
    expect(serviceOf(undefined, ["one link https://example.com only"])).toBeUndefined()
    expect(serviceOf("https://developers.deepgram.com/docs", [])).toBe("deepgram.com")
    expect(serviceOf("https://api.acme.co.uk", [])).toBe("acme.co.uk")
    expect(setupCommands("```bash\nnpm i -g @runcomfy/cli    # global\nnpx -y @runcomfy/cli --version\nruncomfy login\n$ brew install ffmpeg\n```")).toEqual(["npm i -g @runcomfy/cli", "runcomfy login", "brew install ffmpeg"])
  })

  test("a CLI the skill works through is a command; a CLI next to SDK examples is one way among several", () => {
    // RunComfy-shaped: allowed-tools names the CLI; the install alternatives collapse to the first.
    const runcomfy = "```bash\nnpx skills add acme/skills --skill music -g\n```\n```bash\nnpm i -g @runcomfy/cli   # global\nnpx -y @runcomfy/cli --version\nruncomfy login\nruncomfy run music \\\n  --prompt calm\n```"
    const commands = skillCommands(runcomfy, "Bash(runcomfy *)", [runcomfy, "```bash\nbrew install runcomfy/tap/runcomfy\npip install runcomfy\n```"])
    expect(commands).toEqual([{ name: "runcomfy", install: "npm i -g @runcomfy/cli", alternatives: 1, login: "runcomfy login" }])
    expect(setupSteps(runcomfy, commands)).toEqual(["npm i -g @runcomfy/cli (or 1 other way in its docs)", "runcomfy login"])
    // Without allowed-tools, shell-only examples still name it; package managers never count.
    expect(skillCommands(runcomfy, undefined).map((c) => c.name)).toEqual(["runcomfy"])
    // ElevenLabs-shaped: Python and JS do the work, the CLI is an alternative; prose setup is kept.
    const eleven = "> **Setup, before writing any code:** if `ELEVENLABS_API_KEY` isn't set, run `npx -y @elevenlabs/cli@latest onboard init`.\n```python\nfrom elevenlabs import ElevenLabs\n```\n```bash\nelevenlabs text-to-sound-effects convert\n```"
    expect(skillCommands(eleven, undefined, [eleven, "```bash\nnpm install -g @elevenlabs/cli\nelevenlabs auth login\n```"])).toEqual([])
    expect(setupSteps(eleven, [])).toEqual(["npx -y @elevenlabs/cli@latest onboard init"])
    // inference.sh-shaped: no install line, only a link to instructions.
    const belt = "> Requires inference.sh CLI (`belt`). [Install instructions](https://example.com/cli-install.md)\n```bash\nbelt login\nbelt app run x\n```"
    const beltCommands = skillCommands(belt, "Bash(belt *)")
    expect(beltCommands).toEqual([{ name: "belt", installDocs: "https://example.com/cli-install.md", login: "belt login" }])
    expect(setupSteps(belt, beltCommands)).toEqual(["install belt: https://example.com/cli-install.md", "belt login"])
  })

  test("the keys a skill's text reads are found", () => {
    expect(secretsRead('apiKey: process.env.DEEPGRAM_API_KEY\nos.getenv("HF_TOKEN")\nPATH=$HOME')).toEqual(["DEEPGRAM_API_KEY", "HF_TOKEN"])
  })
})

describe("installing", () => {
  test("a skill folder is fetched for review, installed at its commit, and loads with its requirements", async () => {
    const repo = await skillRepo()
    const root = await tmpProject()
    const fetched = await fetchSkill(repo, "tts")
    expect(fetched).toMatchObject({ path: "skills/tts", env: ["ACME_API_KEY"], envFound: ["ACME_EXTRA_TOKEN"], scripts: ["scripts/speak.sh"], compatibility: "Needs an Acme key." })
    await installSkill(root, fetched)
    await fetched.dispose()
    const lock = await readLock(root)
    expect(lock).toMatchObject([{ kind: "skill", id: "tts", source: repo, path: "skills/tts", env: ["ACME_EXTRA_TOKEN"] }])
    expect(lock[0]!.version).toMatch(/^[0-9a-f]{40}$/)
    const pack = await loadPack(referencePackDir(), {}, { projectRoot: root })
    const skill = pack.skills.tts!
    expect(skill.dir).toBe(path.join(root, ".slate/installed/skills/tts"))
    expect(skill.requires.env.sort()).toEqual(["ACME_API_KEY", "ACME_EXTRA_TOKEN"])
    expect(skill.prompt).toContain("# Acme TTS")
    expect(skill.source?.commit).toBe(lock[0]!.version)
    expect(skill.requires.commands).toEqual([])
  })

  test("the programs a skill runs and its service are recorded at install and required when it loads", async () => {
    const repo = await skillRepo()
    const root = await tmpProject()
    const fetched = await fetchSkill(repo, "music")
    expect(fetched).toMatchObject({ service: "acme-music.com", commands: [{ name: "acmemusic", install: "npm i -g @acmemusic/cli", login: "acmemusic login" }], setup: ["npm i -g @acmemusic/cli", "acmemusic login"] })
    await installSkill(root, fetched)
    await fetched.dispose()
    const skill = (await loadPack(referencePackDir(), {}, { projectRoot: root })).skills.music!
    expect(skill.requires.commands).toEqual(["acmemusic"])
    expect(skill.service).toBe("acme-music.com")
    expect(skill.commandHints).toEqual({ acmemusic: "`npm i -g @acmemusic/cli`, then `acmemusic login`" })
  })

  test("a tool becomes a capability whose check is the MCP handshake", async () => {
    const root = await tmpProject()
    const [tool] = await searchTools(base, "voice")
    await installTool(root, tool!)
    const pack = await loadPack(referencePackDir(), {}, { projectRoot: root })
    expect(pack.capabilities.voice).toMatchObject({ env: ["ACME_API_KEY"], mcp: { command: ["npx", "-y", "@acme/mcp-server-voice@1.1.0"] } })
    expect(pack.capabilities.voice!.check).toBeUndefined()
  })

  test("mapping a need keeps the file's comments and the other needs", async () => {
    const root = await tmpProject()
    await mkdir(path.join(root, "specs"))
    await writeFile(path.join(root, "specs/capabilities.yaml"), "# what the product takes\nneeds:\n  - id: audio-synthesis\n    for: spoken clips # EN and ES\n  - id: images\n    for: icons\n")
    await mapNeed(root, "specs/capabilities.yaml", "audio-synthesis", { skill: "tts" })
    await mapNeed(root, "specs/capabilities.yaml", "video", { capability: "voice" }, "a trailer")
    const text = await readFile(path.join(root, "specs/capabilities.yaml"), "utf8")
    expect(text).toContain("# what the product takes")
    expect(text).toContain("# EN and ES")
    expect(YAML.parse(text).needs).toEqual([
      { id: "audio-synthesis", for: "spoken clips", skill: "tts" },
      { id: "images", for: "icons" },
      { id: "video", for: "a trailer", capability: "voice" },
    ])
  })
})

describe("slate skill add", () => {
  test("reviews, installs, maps the need, and the job's check then finds only the missing key", async () => {
    const repo = await skillRepo()
    const root = await tmpProject()
    await saveProjectConfig(root, testConfig({ pack: "full-cycle-software-development" }))
    await mkdir(path.join(root, "specs"))
    await writeFile(path.join(root, "specs/capabilities.yaml"), "needs:\n  - id: audio-synthesis\n    for: spoken clips\n")
    const bin = path.join(import.meta.dir, "..", "bin", "slate.ts")
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, bin, ...args], { cwd: root, env: { ...process.env, ACME_API_KEY: "", ACME_EXTRA_TOKEN: "" } })
    const noReview = run("skill", "add", repo, "tts", "--need", "audio-synthesis")
    expect(noReview.exitCode).not.toBe(0)
    expect(noReview.stderr.toString()).toContain("installing needs your review")
    const r = run("skill", "add", repo, "tts", "--need", "audio-synthesis", "--yes", "--json")
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout.toString().slice(r.stdout.toString().indexOf("{")))).toMatchObject({ installed: { skill: "tts" }, need: "audio-synthesis", missingEnv: ["ACME_API_KEY", "ACME_EXTRA_TOKEN"] })
    expect(YAML.parse(await readFile(path.join(root, "specs/capabilities.yaml"), "utf8")).needs[0].skill).toBe("tts")

    // A job over this project: the need is covered; only the keys are missing, and .env provides one.
    await writeFile(path.join(root, ".env"), "ACME_API_KEY=abc\n")
    const h = await harness({ manifest: {}, usePackDir: referencePackDir(), config: { capabilities: { waive: ["playwright", "ACME_EXTRA_TOKEN"] } } })
    await mkdir(path.join(h.root, ".slate", "installed"), { recursive: true })
    Bun.spawnSync(["cp", "-R", path.join(root, ".slate/installed"), path.join(h.root, ".slate")])
    Bun.spawnSync(["cp", "-R", path.join(root, "specs"), h.root])
    await writeFile(path.join(h.root, ".env"), "ACME_API_KEY=abc\n")
    h.engine.pack = await loadPack(referencePackDir(), {}, { projectRoot: h.root })
    await h.store.update((s) => (s.phase = "plan"))
    delete process.env.ACME_API_KEY
    const st = await h.engine.run()
    expect(st.status).toBe("done")
    expect(process.env.ACME_API_KEY as string | undefined).toBe("abc")
    const build = h.runtime.calls.find((c) => c.step === "build")!
    expect(build.prompt).toContain("use it rather than a stand-in: `tts` (for audio-synthesis).")
    delete process.env.ACME_API_KEY
  }, 120_000)
})
