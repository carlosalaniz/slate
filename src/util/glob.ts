import picomatch from "picomatch"

const cache = new Map<string, (p: string) => boolean>()

export function matcher(patterns: string | string[]): (p: string) => boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  const key = list.join("\u0000")
  let fn = cache.get(key)
  if (!fn) {
    fn = picomatch(list, { dot: true })
    cache.set(key, fn)
  }
  return fn
}

export function matchesAny(p: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  return matcher(patterns)(p.replace(/\\/g, "/"))
}

/** True when two glob sets can both match some path. Conservative: compares literal prefixes before the first wildcard. */
export function globsMayOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a)
  const pb = literalPrefix(b)
  return pa.startsWith(pb) || pb.startsWith(pa)
}

function literalPrefix(glob: string): string {
  const idx = glob.search(/[*?[{]/)
  return idx === -1 ? glob : glob.slice(0, idx)
}
