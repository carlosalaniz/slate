# Slate

Workflow runner for long, unattended agent jobs, built as an **OpenCode v2 plugin plus a thin CLI**.

OpenCode supplies the agent runtime: models, tools, permissions, sessions, worktrees, retries, cost.
Slate supplies the loop: phases, bounded retries, output contracts, checkpoints, dependency-aware
blocking, and packs. It never touches a model turn; it only acts at the boundary between turns.

Runtime: **Bun** (the OpenCode SDK uses `bun:sqlite` and `bun:ffi`, so Node cannot host it).

```
bun install
bun run slate --help
bun run check            # typecheck + tests
```

Every option is documented in [`config.example.yml`](./config.example.yml) — copy it to
`slate.config.yml` in your project root, or generate one with `slate init`.

## Quick start

```
cd my-project
slate init                            # config, then discovery opens in OpenCode: talk it through, then quit
slate discover                        # reopen discovery if you quit before it was done
slate start                           # plan and build; asks supervised (here) or unattended (background)
slate check                           # what the job needs (tools, image input, discovery's needs), checked for free
slate status                          # where the job is, what it needs from you, what it cost
slate inbox                           # answer open questions one at a time
slate log s1-t1                       # why a task looks the way it does
slate stop                            # checkpoint after the current step
slate continue                        # resume (this is also how you retry) or attach
```

Discovery always happens with you present: it runs in your own OpenCode (install it and connect a
provider first), which also supplies the providers and models `slate init` offers. Only plan, build
and close can run unattended.

`slate start --dry-run --yes --idea "..."` runs the entire loop with a fake runtime that writes the
contract files and makes no model calls. It is the fastest way to see what a pack does.

## Layout

```
bin/slate.ts                 CLI entrypoint
src/cli/                     nine commands; every one accepts --json
src/engine/                  the loop, one concern per file (see below)
src/engine/capabilities.ts   what steps require (tools, model modalities, discovery needs) and the free checks
src/pack/                    pack schema (zod), loader/validator, installed-pack registry
src/opencode/adapter.ts      the ONE module that talks to @opencode/sdk (Runtime interface impl)
src/opencode/plugin.ts       the Slate plugin: agent/skill transforms, consult tool, gates, retry hook
src/opencode/fake.ts         FakeRuntime for tests and --dry-run
packs/slate-core/            Slate's own agents, skills and prompt templates (every text Slate sends a model)
packs/full-cycle-software-development/   reference pack (YAML + markdown + scripts)
test/                        bun test
```

A project Slate manages gets `slate.config.yml` at its root and everything else under `.slate/`:
`state.json` (checkpoint after every step), `log.jsonl` (audit), `brief.md`, `consults/`, `answers/`
(how `inbox` talks to a running engine), `control/` (how `stop` and `plan revise` do), `worktrees/`.

## The engine, file by file

| File | Does one thing |
| --- | --- |
| `engine.ts` | holds one job's process state; `run`, `requestStop`, `answer` |
| `run.ts` | lifecycle: intake, the four phases, what a resume resets, done/stopped/failed |
| `intake.ts` | idea → `.slate/brief.md` → pack proposal → pinned pack |
| `sequence.ts` | steps in order; skips what passed; hands a failure upward |
| `step.ts` | the leaf steps: skill (agent session + output contract), script, approval |
| `loops.ts` | `until` rounds, `over` items, what happens when rounds run out |
| `parallel.ts` | lanes side by side; an `over` loop in a lane ends only when every lane is idle |
| `capabilities.ts` | requirements and the preflight: checks tools, MCP servers, model modalities and discovery needs, free |
| `prepare.ts` | job context, scope, permission rules, attached files, the step prompt |
| `inbox.ts` | questions: open, wait, answer (in process or via `.slate/answers/`) |
| `spend.ts` | cost accounting and budget caps |
| `control.ts` | the checkpoint before every step, `slate stop`, `slate plan revise` |
| `core-pack.ts` | loads `packs/slate-core` and fills its prompt templates |

## How the engine decides

```
while step := manifest.next(state):
  worktree = worktrees.for(step)                 # per task in build; shared elsewhere
  session  = oc.sessions.create(agent, model=tier(step), directory=worktree, permissions=scope(step))
  oc.sessions.prompt(session, skill prompt + attached reads)
  oc.sessions.wait(session)
  outcome  = check(step.writes, step.result)     # missing file or bad verdict = fail, never silent
  state.advance(step, outcome)                   # a failure goes up to the nearest until loop
  checkpoint(state)
```

* **Output contracts.** After a session ends the only judge is the filesystem: every `writes` file must
  exist and `result.field` must be exactly `pass` or `fail`. A failed contract gets one re-prompt in the
  same session with the schema, then counts as a failed round.
* **Retry is always a loop.** A failed step (missed contract, `fail` verdict, failed check, rejected
  approval) fails the round of the nearest enclosing `until` loop, which runs its steps again, up to
  `max` rounds. When rounds run out, `on_exhausted` decides: `ask-human` / `ask-decision-agent` answer
  *retry* (`max` more rounds), *skip* (the loop counts as done) or *stop* (the job stops); `fail` makes
  the loop itself fail, which fails the round of the loop around it. That is how a pack says "redesign
  when the build keeps failing": wrap design and build in an outer `until` loop (see the reference
  pack's `design` loop). In an `over` loop, a failed item stops new items from starting; running items
  finish, then the failure goes up.
* **Outside loops, stop and continue is the retry.** A failure with no `until` loop around it fails
  the job (a rejected approval stops it instead, with your note in `.slate/plan-revisions.md`). `slate continue` re-runs what failed and skips what passed, and gives loops that ran out of
  rounds `max` more.
* **Infra failure is not work failure.** Provider errors are retried by OpenCode's `retry` hook (Slate's
  policy: 429/5xx/network, exponential backoff) and then by the engine (`runtime.infra_retries`). They
  never count against rounds. If they keep failing, or a script exits nonzero (broken, not a failed
  check), the job stops with the reason; fix it and `slate continue`.
* **Every question pauses only its branch.** Approvals, loops out of rounds, permission asks and
  native question forms pause the branch that raised them; other stories keep running up to
  `story_concurrency`. `slate status` says *waiting on you* when nothing else can move.
  `autonomy.on_timeout` decides what happens after `question_timeout_hours`. Questions belong to the
  running engine: a resumed job asks again.
* **A budget hit stops the job.** When `budget.job`, `budget.per_task` or a `budget.per_model` cap is
  reached, every branch stops at its next step boundary. Raise the cap in `slate.config.yml`, then
  `slate continue`.
* **Resume never replays a partial step.** A step is recorded only when it finishes; on `continue` any
  step still marked running is discarded and re-run. Iteration values from `over` scripts are recorded
  so replay does not re-ask the script.
* **Requirements are checked before any work, for free.** On every `start` and `continue` (and again
  when a job reaches plan after running discovery itself) Slate collects what the remaining steps
  require: tools (capability checks and their MCP servers), model modalities on the tiers the steps
  run on, and the pack's `needs` file. Nothing calls a model. Anything missing halts the job with
  the fix, unless it is waived in `slate.config.yml` (`capabilities.waive`), in which case agents
  are told it is unavailable. `slate check` runs the same checks on demand.
* **Isolation.** A loop's items get their own worktree when the loop says so (`worktree: true`, the
  default for `as: task` loops in build): a `git worktree add` on branch `slate/<item>`, falling back
  to a copy. `worktree: git` never copies: without git the items run in the project one at a time,
  and each item's worktree is removed once it is done. The reference pack builds each story this way
  and lands it on the project's branch in its `close` loop (merge the branch in, resolve, land).

## Mapping to OpenCode v2 (verified against `@opencode/sdk` 2.0.15)

| Pack construct | OpenCode v2 |
| --- | --- |
| `agents/*.yml` | `ctx.agent.transform` → `editor.update(id, ...)` with `mode`, `model`, `system`, `steps`, `permissions`. Consultants get `mode: subagent`, deny edit/shell/subagent, a `steps` cap. Reviewers are not registered. |
| tier `low/medium/high` | `{ providerID, id }` from `slate.config.yml`; packs never carry model names |
| `skills/*.yml` | `ctx.skill.transform` → `editor.add({ id, name, description, path, content })`; the resolved prompt is also inlined in the step prompt |
| `skill.reads` | `session.prompt({ files: [{ uri }] })` |
| agent `scope`, step `scope` | per-session `permissions` rules on `session.create`; broad denies first, specific allows last |
| `consult` | `ctx.tool.transform` → `editor.add({ name: "consult" })`; executor opens a child session for the consultant, waits, parses `verdict:`, writes `consults/{step}/{n}.md`; depth one; native `subagent` denied everywhere |
| `gates` | `ctx.permission.hook("evaluate")`; reviewers run through `ctx.generate.text` and must cite an input line; approve→allow, reject→deny with reason, escalate→ask (lands in the inbox with notes) |
| infra retry | `ctx.session.hook("retry")` |
| questions | `permission.asked` and `form.created` events → inbox; answered with `permission.reply` / `session.form.reply` |
| cost | `session.get().cost` and `tokens` (v2 exposes per-session cost directly) |
| capability `mcp` | `mcp.add({ server, location, config })` per warmed directory, `codemode: false`; its tools are permission actions `<server>_<tool>`, denied except to agents/skills that require the capability |
| `requires.model` | `model.list` → `capabilities.input` / `output` (models.dev modalities) |
| worktrees | `worktree.create({ projectID, name, directory })` |

Facts learned in the spike that the adapter depends on:

1. Plugin `setup` runs **lazily per location**, the first time a capability-reading call (permission
   list, prompt) touches that directory, and the transforms apply asynchronously after that. The
   adapter warms each directory before its first session and waits until Slate's agents are listed.
2. Without provider credentials the default model routes to OpenCode's free tier, which refuses
   embedded hosts. Slate pins `{ providerID, id }` on every session from `slate.config.yml`.
3. `session.create` accepts per-session `permissions` and they persist on the session.
4. The SQLite database directory must exist before `OpenCode.create`.
5. `mcp.add` keeps the server in memory for that location only (it never writes the project's config),
   so the adapter adds every capability server to each directory it warms. `mcp.list` reports
   `connected | pending | failed | needs_auth | disabled` without any model call.
6. MCP tools are registered as `<server>_<tool>` (non-alphanumerics become `_`); with `codemode`
   left on they hide behind `execute`, so Slate sets `codemode: false` to permission them one by one.
7. Two parts of the host log outside the `log` option: the process spawner (Effect's default logger,
   `console.log`) and the MCP client (`console.debug`). The adapter mutes console.log/info/debug while
   the host runs; Slate itself prints only through process.stdout/stderr.
8. `@playwright/mcp` uses the installed Chrome by default; `--browser chromium` wants a newer build
   than Playwright's own cache may have. The capability check drives the server once to find out.

## Pack schema

Discovery: `slate discover` starts with Slate's own lead, which asks what the person is building and
which installed pack fits. Once they pick yours, the same OpenCode conversation is handed to the
agent named in `discovery: { lead: <agent> }` (its prompt plus Slate's rules); it runs the rest of
the interview and has the agents behind your `phases.discovery` skill steps write those documents.
Without a `lead`, a generic one with Slate's rules takes over.

See `packs/full-cycle-software-development/slate-pack.yml` for a complete example. Step types:
`skill` (`skill`, `by`, `model?`, `writes?`, `result?`, `scope?`, `consult?`, `gates?`), `loop`
(`over`/`until`, `as`, `max`, `concurrency?`, `on_exhausted?` = `ask-human | ask-decision-agent | fail`,
`worktree?`, `steps`), `approval` (`prompt`, `show?`), `script` (`script`, `args?`), `parallel` (`steps`:
two or more lanes that run side by side; an `over` loop that is a lane ends only when every lane is
idle and none has more work, so lanes can feed each other; inside a lane, `done` from the loop's
script means "nothing now"). An `until` round
passes when `{ result: <step> }` has verdict `pass`, when `{ script, args }` answers `{ "pass": true }`,
or, with `until: all-pass`, when every step in the round passed. The reference pack uses `all-pass`
for its `planning` loop (rejecting the plan with a note rewrites it) and its `design` loop. `${name}` resolves from config at load;
`{story}`, `{task}`, `{round}`, `{round.<loop>}`, `{workspace}`, `{run}`, `{step}` resolve per execution
(script `args` may use `${name}` too).
Scripts are split in two: `scripts/<id>.yml` (description, `run`, `timeout`) and the code in
`scripts/scripts/`, written in TypeScript and run with Bun (`run: "bun $SLATE_PACK/scripts/scripts/<id>.ts"`;
Bun runs `.ts` directly and has `Bun.YAML` built in). The loader rejects code files placed directly in
`scripts/`. A script prints one JSON object and exits 0; any other exit means it is broken and stops
the job. `{ "ok": false }` is a failed check; add `"halt": true` when no retry can fix it (something a
person has to provide) and the job halts instead. Scripts receive `SLATE_WORKSPACE`, `SLATE_RUN`,
`SLATE_PACK`, `SLATE_VAR_<NAME>` (including `SLATE_VAR_WAIVED`, the waived ids), and for `over` loops
`SLATE_CLAIMED` / `SLATE_RUNNING` (JSON arrays) so they never hand out the same item twice.

Requirements. Agents, skills and scripts may declare
`requires: { tools: [<capability>], model: { input: [image|audio|video|pdf], output: [...] } }`
(scripts: tools only). A capability is `capabilities/<id>.yml` in the pack or in slate-core:
`description`, `check` (a command under the script contract that must cost nothing: no model, no paid
API call), `install` (shown when the check fails) and optionally `mcp: { command, environment?,
startup? }`, a local MCP server whose tools only the agents and skills that require it may call (its
check receives the command in `SLATE_MCP_COMMAND` so it can drive the server once). A pack's
`needs: <file>` names a file discovery writes (the reference pack: `specs/capabilities.yaml`) that
maps what the product takes beyond code (sound, images, ...) to an installed `skill:` or
`capability:`; a need mapped to nothing halts the job before planning, and the tools of mapped
skills go to every worker. `.slate/capabilities.md` lists the installed skills and tools for
discovery. In `slate.config.yml`, `capabilities.waive` lists tool ids, modality ids
(`image-input`, `audio-output`, ...) and need ids to go without.

`slate pack validate <dir>` checks schemas, every id reference (including required tools), and roles
(only workers run steps, reviewers never consult).

The reference pack builds in two lanes. Stories build and land in one; in the other, every story
that lands with `screens:` gets a UX review: `ux-screenshots` serves what has landed from a
throwaway checkout, screenshots each screen at every `ux_viewports` size and measures overflowing
text, overlapping controls, small touch targets and horizontal scroll; the UX designer reviews the
screenshots against the spec; `file-ux-fixes` turns must-fix issues into a fix story the story lane
builds next. `ux_passes` bounds the rounds per story (0 turns it off). Builders list stand-ins they
create under `placeholders:` in their build report, and `check-placeholders` halts the close phase
while any is unchanged (`placeholders: report` ships them, reported in the run summary).

`packs/slate-core` is a pack like any other plus `prompts/*.md`: the step framing, the contract
re-prompt, consult framing, the gate reviewer's answer format, pack proposal, the stuck-loop decision
and plan revisions; `prompts/messages.yml` holds the short texts agents read as tool results
(consult refusals, gate decisions). `{name}` placeholders are filled in; a line whose placeholders are all empty is
left out. It is loaded for every job and never offered as a workflow. See its README for the list.

## Status against the scope document

| Milestone | State |
| --- | --- |
| M0 spike | Done: embedded host, agent/skill/tool transforms, per-session permissions, consult tool and gate hook registration verified on 2.0.15. Not yet run against a paid provider with a real model turn. |
| M1 loop | Done: loader/validator, all four step types, contracts, checkpoints, `init/start/continue/stop`, reference pack, sequential stories. Verified end to end with the fake runtime. |
| M2 long runs | Done in code: `status/inbox/log`, branch-level blocking, `story_concurrency`, worktree per task, budgets, retry hook, `--detach`. Needs a real long run for tuning. |
| M3 packs | Done: `pack add/list/update/validate`, engine-owned intake and pack proposal, `consult` and `gates` in the schema, all reference agents, `plan revise`, `--json` everywhere. |

Open questions from the document, answered by the spike: v2 exposes per-session cost directly;
consult children are separate sessions in the parent's directory with their own deny rules;
`ask-decision-agent` is a reviewer-style transient call; one job per project for v1 (finished jobs are
archived as `.slate/state.<id>.json`).
