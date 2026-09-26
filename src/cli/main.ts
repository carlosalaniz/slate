import { parseArgs, bool } from "./args.ts"
import { Output, CliError } from "./output.ts"
import { PackError } from "../pack/loader.ts"

const COMMANDS: Record<string, { run: (argv: string[], out: Output) => Promise<number>; help: string }> = {}

export function register(name: string, help: string, run: (argv: string[], out: Output) => Promise<number>) {
  COMMANDS[name] = { run, help }
}

/** Runs another command in this process, e.g. discovery continuing into `slate start`. */
export function runCommand(name: string, argv: string[], out: Output): Promise<number> {
  return COMMANDS[name]!.run(argv, out)
}

const HELP = `slate — workflow runner for long, unattended agent jobs (OpenCode v2 plugin + CLI)

usage: slate <command> [options]   (every command accepts --json)

  init       Set up the project (name, provider and models from your OpenCode, budget), then open discovery.
  defaults   Save answers \`slate init\` reuses (provider, models, budgets) to ~/.slate_defaults.yml.
  discover   Discovery in OpenCode, with you: writes the brief, picks the pack, writes the pack's discovery docs.
  start      Start a job from a finished discovery: plan, build, close. Asks supervised or unattended.
  continue   Reattach to the current job to watch or give input. Resumes it if stopped.
  check      What the job needs (tools, model input such as images, discovery's needs), checked for free.
  status     Questions waiting on you, what is running or blocked, spend per model/task/story, contract failures.
  inbox      Walk through open questions one at a time with their context. Works without attaching.
  log        Decisions and reasoning per task: consults, verdicts, gates, retries, loop rounds. \`slate log <task>\` for one.
  plan       View or revise the approved plan mid-build.
  pack       add | list | update | validate
  stop       Finish the current step, checkpoint, halt. --now interrupts in-flight sessions.

run \`slate <command> --help\` for options.`

export async function main(argv: string[]): Promise<number> {
  await import("./commands/index.ts")
  const parsed = parseArgs(argv)
  const out = new Output(bool(parsed.flags, "json"))
  if (!parsed.command || parsed.command === "help" || (bool(parsed.flags, "help", "h") && !parsed.command)) {
    out.emit(() => HELP, { commands: Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, v.help.split("\n")[0]])) })
    return 0
  }
  const cmd = COMMANDS[parsed.command]
  if (!cmd) {
    out.err(`unknown command '${parsed.command}'\n\n${HELP}`)
    return 2
  }
  if (bool(parsed.flags, "help", "h")) {
    out.emit(() => cmd.help, { command: parsed.command, help: cmd.help })
    return 0
  }
  try {
    return await cmd.run(argv.slice(1), out)
  } catch (e) {
    if (e instanceof CliError) {
      if (out.json) process.stdout.write(JSON.stringify({ error: e.message, hint: e.hint }) + "\n")
      else out.err(`error: ${e.message}${e.hint ? `\n  ${e.hint}` : ""}`)
      return e.code
    }
    if (e instanceof PackError) {
      if (out.json) process.stdout.write(JSON.stringify({ error: "invalid pack", problems: e.problems }) + "\n")
      else out.err(`invalid pack:\n${e.problems.map((p) => `  - ${p}`).join("\n")}`)
      return 1
    }
    throw e
  }
}
