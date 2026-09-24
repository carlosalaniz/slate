{reviewer_prompt}

An agent wants to perform action '{action}' on: {resources}
Decide whether to approve it. You must cite the line of an input file you relied on; a decision without a citation is escalated to a human.
Answer with exactly these three lines:
decision: approve | reject | escalate
cite: <file>:<line or quote>
note: <one sentence>

{inputs}
