import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { shareOpenCodeKeys } from "./credentials.ts"

/**
 * The providers and models the user's OpenCode can actually use, read from a short-lived embedded
 * host: env-var keys from the shell plus the API keys saved in OpenCode (see credentials.ts). Used by
 * `slate init` so nobody has to type provider or model ids.
 */

export interface CatalogProvider {
  id: string
  name: string
}

export interface CatalogModel {
  providerID: string
  id: string
  name: string
  /** USD per million tokens, when OpenCode knows it. */
  cost?: { input: number; output: number }
  context?: number
  released?: number
  /** Output modalities, e.g. ["text"] or ["text", "image"]. */
  outputs?: string[]
}

export interface Catalog {
  providers: CatalogProvider[]
  models: CatalogModel[]
}

/** OpenCode Zen's free tier refuses embedded hosts, so it is never offered. */
const HIDDEN_PROVIDERS = new Set(["opencode"])

/**
 * Starts an embedded host on a throwaway database, waits for its catalog to settle, and returns the
 * connected providers with their usable models (tool-capable, enabled, not deprecated).
 */
export async function loadCatalog(opts: { timeoutMs?: number } = {}): Promise<Catalog> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slate-catalog-"))
  const sdk = await import("@opencode/sdk")
  const oc: any = await sdk.OpenCode.create({ database: { path: path.join(dir, "opencode.sqlite") }, log: { level: "error", emit: () => {} } })
  try {
    const loc = { location: { directory: dir } }
    // Listing needs the location initialized; a throwaway session plus a capability read does that.
    const s = await oc.sessions.create({ location: { directory: dir }, title: "slate catalog" })
    await oc.permission.list({ sessionID: s.id }).catch(() => undefined)
    await shareOpenCodeKeys(oc, dir)
    // The catalog loads asynchronously. It is ready once the always-present Zen provider shows up
    // and the model count stops changing between polls.
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
    let providers: any[] = []
    let models: any[] = []
    let lastCount = -1
    while (Date.now() < deadline) {
      providers = (await oc.provider.list(loc)).data ?? []
      models = (await oc.model.list(loc)).data ?? []
      if (providers.some((p) => p.id === "opencode") && models.length === lastCount) break
      lastCount = models.length
      await Bun.sleep(300)
    }
    await oc.sessions.remove({ sessionID: s.id }).catch(() => undefined)
    const visible = providers.filter((p) => !HIDDEN_PROVIDERS.has(p.id))
    const ids = new Set(visible.map((p) => p.id))
    return {
      providers: visible.map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) })),
      models: models
        .filter((m) => ids.has(m.providerID) && m.enabled !== false && m.status !== "deprecated" && m.capabilities?.tools !== false)
        .map((m) => {
          const cost = Array.isArray(m.cost) ? m.cost[0] : m.cost
          return {
            providerID: String(m.providerID),
            id: String(m.id),
            name: String(m.name ?? m.id),
            cost: cost && typeof cost.input === "number" ? { input: cost.input, output: Number(cost.output ?? 0) } : undefined,
            context: typeof m.limit?.context === "number" ? m.limit.context : undefined,
            released: typeof m.time?.released === "number" ? m.time.released : undefined,
            outputs: Array.isArray(m.capabilities?.output) ? m.capabilities.output.map(String) : undefined,
          }
        }),
    }
  } finally {
    await oc.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Default model per tier for one provider: the preferred ids when present (also under an aggregator's
 * naming), otherwise by price within the provider's current generation (released within 90 days of its newest model; text-only output;
 * priority "-fast" variants left out): cheapest for low, the middle for medium, the most expensive
 * for high. Ties go to the shorter id, which is usually the base model rather than a variant.
 */
export function defaultTiers(models: CatalogModel[], preferred?: { low: string; medium: string; high: string }): { low?: string; medium?: string; high?: string } {
  // Aggregators name the same model differently ("anthropic/claude-haiku-4.5" for
  // "claude-haiku-4-5-20251001"), so compare without vendor prefix, dots or a date suffix.
  const norm = (id: string) => id.split("/").pop()!.replace(/\./g, "-").replace(/-\d{8}$/, "")
  const has = (id?: string) => (id ? (models.find((m) => m.id === id) ?? models.find((m) => norm(m.id) === norm(id)))?.id : undefined)
  const newest = Math.max(0, ...models.map((m) => m.released ?? 0))
  const current = models.filter(
    (m) => !/-fast$/.test(m.id) && (!m.outputs || m.outputs.every((o) => o === "text")) && (!newest || (m.released ?? 0) >= newest - 90 * 86_400_000),
  )
  const price = (m: CatalogModel) => (m.cost ? m.cost.input + m.cost.output : 0)
  const priced = current.filter((m) => price(m) > 0)
  const pool = priced.length ? priced : current.length ? current : models
  const cheapFirst = [...pool].sort((a, b) => price(a) - price(b) || a.id.length - b.id.length)
  const dearFirst = [...pool].sort((a, b) => price(b) - price(a) || a.id.length - b.id.length)
  return {
    low: has(preferred?.low) ?? cheapFirst[0]?.id,
    medium: has(preferred?.medium) ?? cheapFirst[Math.floor((cheapFirst.length - 1) / 2)]?.id,
    high: has(preferred?.high) ?? dearFirst[0]?.id,
  }
}
