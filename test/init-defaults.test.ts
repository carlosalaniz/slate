import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { loadInitDefaults } from "../src/config/init-defaults.ts"
import { tmpProject } from "./helpers.ts"

describe(".slate_defaults.yml", () => {
  test("the nearest file up the tree wins", async () => {
    const top = await tmpProject()
    const project = path.join(top, "work", "app")
    await mkdir(project, { recursive: true })
    await writeFile(path.join(top, ".slate_defaults.yml"), "provider: openrouter\nmodels: { low: a, medium: b, high: c }\ndiscover: false\n")
    expect((await loadInitDefaults(project))?.values).toEqual({ provider: "openrouter", models: { low: "a", medium: "b", high: "c" }, discover: false })
    await writeFile(path.join(top, "work", ".slate_defaults.yml"), "budget: { job: 20 }\n")
    expect((await loadInitDefaults(project))?.values).toEqual({ budget: { job: 20 } })
  })

  test("unknown keys are an error, not silently ignored", async () => {
    const root = await tmpProject()
    await writeFile(path.join(root, ".slate_defaults.yml"), "provder: openrouter\n")
    expect(loadInitDefaults(root)).rejects.toThrow("provder")
  })
})
