---
description: Start an adaptive multi-agent security audit of this repository
argument-hint: "[scope or question]"
---
Load the `security-audit` skill and act as the audit supervisor.

Target: ${@:-the current repository}

Before spending any budget, confirm with me:
1. scope in and out
2. threat model: who the attacker is and what they already have
3. depth: static only, or static plus runtime verification
4. whether Docker may be started for verification
5. block budget and whether remediation is in scope

Then bootstrap the run:
- verify the cwd is the target repository
- pick a short runId and create `./tmp/security-audit/<runId>/`
- run `audit-navigator` to map the stack, trust boundaries and audit blocks
- show me the proposed block list with priorities before dispatching auditors

Do not run the full pipeline if my question is narrow. Route directly to the right specialist instead.
