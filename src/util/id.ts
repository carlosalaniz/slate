export function shortId(prefix = ""): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return prefix ? `${prefix}_${t}${r}` : `${t}${r}`
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "job"
}
