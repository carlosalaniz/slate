# slate-core

Every word Slate itself sends to a model lives in this pack. Edit these files to change how Slate
talks to agents; no TypeScript change is needed.

- `agents/` and `skills/` work like in any pack. `slate-intake` + `slate-write-brief` write the
  brief; `slate-pack-proposer` picks a pack; `slate-decision` answers stuck loops when the policy
  is `ask-decision-agent`.
- `prompts/*.md` are templates. `{name}` is replaced with a value. A line whose placeholders are
  all empty is left out, which is how optional lines (scope, consult, result file, ...) disappear.
- `capabilities/` holds the tools every pack can require (a pack's own file with the same id wins):
  `playwright` (headless Chromium; its check launches the browser and drives the MCP server once).
- `prompts/messages.yml` holds the short texts an agent reads as a tool result or a permission
  decision: consult refusals, the consult answer wrapper, gate allow/deny/ask messages. Same rules.

| Template | Sent when | Placeholders |
| --- | --- | --- |
| `step.md` | every skill step starts | step, phase, directory, story, task, loops, retried_loops, scope, writes, result_file, result_field, consult_agents, consult_max, tools, product_skills, waived, skill_prompt, step_prompt |
| `reprompt.md` | a step ended without its output contract (missing, or YAML/JSON that does not parse) | missing, invalid, writes, result_file, result_field |
| `plan-revision.md` | `slate plan revise` re-runs the plan steps | revision, note |
| `consult.md` | an agent calls the `consult` tool | parent_agent, step, question |
| `consult-verdict.md` | a consultant forgot its verdict line | (none) |
| `consult-tool.md` | the `consult` tool is registered (frontmatter holds argument descriptions) | (none) |
| `gate-review.md` | a gate asks a reviewer | reviewer_prompt, action, resources, inputs |
| `pack-proposal.md` | intake picks a pack (dry runs without discovery) | packs, brief |
| `discovery-agent.md` | `slate discover` writes the lead to `.opencode/agents/slate-discovery.md` (system prompt; Slate adds the frontmatter) | project, brief_path, packs, pack_options |
| `discovery-subagent.md` | the same, for each pack agent that drafts a discovery document | agent_prompt, project |
| `discovery-stub.md` | placeholder for a discovery document once the pack is chosen | marker, file, agent, instructions |
| `discovery-start.md` | the first message of a discovery conversation | project |
| `decision.md` | a loop with `ask-decision-agent` runs out of rounds | loop, max, last_failure, context |
