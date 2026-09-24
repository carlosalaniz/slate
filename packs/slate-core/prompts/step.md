[Slate] step '{step}' in phase {phase}.
Working directory: {directory}. Paths below are relative to it.
story: {story}
task: {task}
Retry loops you are inside, innermost first: {loops}.
Earlier rounds of {retried_loops} did not pass. Read the latest review or verdict files before changing anything.
You may only create or modify files matching: {scope}. Everything else is read-only.
Output contract: when you stop, these files must exist: {writes}.
The file {result_file} must begin with YAML frontmatter containing `{result_field}: pass` or `{result_field}: fail` (exactly one of those two words).
You may use the `consult` tool to ask {consult_agents} (at most {consult_max} times).
Do the work, write the files, then stop. Do not ask questions; state assumptions in the output.

---

{skill_prompt}
{step_prompt}
