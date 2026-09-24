import YAML from "yaml"

export interface Frontmatter {
  data: Record<string, unknown>
  body: string
  present: boolean
}

/** Parses a leading YAML frontmatter block (--- ... ---). Tolerates CRLF and a BOM. */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, "")
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!match) return { data: {}, body: src, present: false }
  let data: unknown
  try {
    data = YAML.parse(match[1] ?? "")
  } catch {
    return { data: {}, body: src.slice(match[0].length), present: true }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { data: {}, body: src.slice(match[0].length), present: true }
  }
  return { data: data as Record<string, unknown>, body: src.slice(match[0].length), present: true }
}

/** Reads a single top-level field from frontmatter, or from a `field: value` line in the body as a fallback. */
export function readField(text: string, field: string): unknown {
  const fm = parseFrontmatter(text)
  if (fm.present && field in fm.data) return fm.data[field]
  const re = new RegExp(`^\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+?)\\s*$`, "mi")
  const m = re.exec(fm.body)
  if (!m) return undefined
  const raw = (m[1] ?? "").trim()
  try {
    return YAML.parse(raw)
  } catch {
    return raw
  }
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(data).trimEnd()}\n---\n${body}`
}
