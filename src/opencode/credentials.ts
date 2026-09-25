import os from "node:os"
import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { Database } from "bun:sqlite"

/**
 * Reuses the API keys the user already gave OpenCode. Slate's embedded host runs on its own database,
 * so it cannot see the user's OpenCode logins, and opening the user's database through the SDK would
 * migrate it to the SDK's schema (possibly past the installed OpenCode). Instead: read the user's
 * database read-only and hand each key to Slate's host as the provider's env var, in this process
 * only. Nothing is written to disk. OAuth logins are not reused.
 */

/** Env var names Slate set in this process; stripped from pack script environments. */
const exported = new Set<string>()
export function exportedKeyNames(): ReadonlySet<string> {
  return exported
}

function openCodeDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
}

export interface StoredKey {
  providerID: string
  key: string
}

/** Active API-key credentials from the user's OpenCode: its database, then the legacy auth.json. */
export function readOpenCodeKeys(): { keys: StoredKey[]; oauth: string[] } {
  const keys = new Map<string, string>()
  const oauth = new Set<string>()
  const dir = openCodeDataDir()
  const dbPath = path.join(dir, "opencode.db")
  if (existsSync(dbPath)) {
    let db: Database | undefined
    try {
      db = new Database(dbPath, { readonly: true })
      const rows = db.query("SELECT integration_id AS id, value FROM credential WHERE active = 1").all() as { id: string; value: string }[]
      for (const r of rows) {
        const v = safeJson(r.value)
        if (v?.type === "key" && typeof v.key === "string") keys.set(r.id, v.key)
        else if (v?.type === "oauth") oauth.add(r.id)
      }
    } catch {
      /* unreadable or a different schema: fall through to auth.json */
    } finally {
      db?.close()
    }
  }
  const legacy = path.join(dir, "auth.json")
  if (existsSync(legacy)) {
    const all = safeJson(readFileSync(legacy, "utf8")) ?? {}
    for (const [id, v] of Object.entries<any>(all)) {
      if (keys.has(id)) continue
      if (v?.type === "api" && typeof v.key === "string") keys.set(id, v.key)
      else if (v?.type === "oauth") oauth.add(id)
    }
  }
  return { keys: [...keys].map(([providerID, key]) => ({ providerID, key })), oauth: [...oauth].filter((id) => !keys.has(id)) }
}

/**
 * Sets each stored key as its provider's env var (names come from the host's integration list) unless
 * the shell already set one, then waits for the host to list those providers. Returns the provider
 * ids it exported.
 */
export async function shareOpenCodeKeys(oc: any, directory: string, opts: { timeoutMs?: number } = {}): Promise<string[]> {
  const { keys } = readOpenCodeKeys()
  if (!keys.length) return []
  const loc = { location: { directory } }
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  // The integration catalog loads asynchronously too.
  let integrations: any[] = []
  while (Date.now() < deadline) {
    integrations = (await oc.integration.list(loc)).data ?? []
    if (integrations.length) break
    await Bun.sleep(250)
  }
  const shared: string[] = []
  for (const { providerID, key } of keys) {
    const names: string[] = integrations.find((i) => i.id === providerID)?.methods?.filter((m: any) => m.type === "env").flatMap((m: any) => m.names ?? []) ?? []
    if (!names.length || names.some((n) => process.env[n])) continue
    process.env[names[0]!] = key
    exported.add(names[0]!)
    shared.push(providerID)
  }
  // The host notices new env keys asynchronously; wait until it lists them.
  while (shared.length && Date.now() < deadline) {
    const listed = new Set(((await oc.provider.list(loc)).data ?? []).map((p: any) => p.id))
    if (shared.every((id) => listed.has(id))) break
    await Bun.sleep(250)
  }
  return shared
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
