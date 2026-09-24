export function nowIso(): string {
  return new Date().toISOString()
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}

export function ageOf(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso))
  return formatDuration(ms)
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Parses "30s", "5m", "2h", "1500ms" or a plain number of milliseconds. */
export function parseDuration(v: string | number | undefined, fallbackMs: number): number {
  if (v === undefined || v === null) return fallbackMs
  if (typeof v === "number") return v
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(v)
  if (!m) return fallbackMs
  const n = Number(m[1])
  switch (m[2]) {
    case "ms":
      return n
    case "m":
      return n * 60_000
    case "h":
      return n * 3_600_000
    case "s":
    default:
      return n * 1000
  }
}

export function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`
}
