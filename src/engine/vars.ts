/**
 * Two variable forms:
 *  - `${name}`: resolved at pack load from config (numbers, policies). Handled by the loader.
 *  - `{name}`: resolved per execution: {story}, {task}, {round}, {round.<loop>}, {workspace}, {run}, {step}.
 */

const RUNTIME_VAR = /\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)?)\}/g

export function resolveRuntime(template: string, vars: Record<string, string>, opts: { strict?: boolean } = {}): string {
  return template.replace(RUNTIME_VAR, (whole, name: string) => {
    const v = vars[name]
    if (v === undefined) {
      if (opts.strict) throw new Error(`unresolved variable {${name}}`)
      return whole
    }
    return v
  })
}

export function hasUnresolved(s: string): boolean {
  return RUNTIME_VAR.test(s)
}

export function listVars(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(RUNTIME_VAR)) out.add(m[1] ?? "")
  return [...out]
}

const CONFIG_VAR = /^\$\{([a-zA-Z0-9_]+)\}$/
const CONFIG_VAR_INLINE = /\$\{([a-zA-Z0-9_]+)\}/g

/** Resolves `${name}` against config. A value that is exactly `${x}` takes x's typed value; inline forms are stringified. */
export function resolveConfigValue<T = unknown>(value: unknown, config: Record<string, unknown>, where: string): T {
  if (typeof value !== "string") return value as T
  const whole = CONFIG_VAR.exec(value)
  if (whole) {
    const name = whole[1] ?? ""
    if (!(name in config)) throw new Error(`${where}: unknown config variable \${${name}}`)
    return config[name] as T
  }
  return value.replace(CONFIG_VAR_INLINE, (_, name: string) => {
    if (!(name in config)) throw new Error(`${where}: unknown config variable \${${name}}`)
    return String(config[name])
  }) as T
}
