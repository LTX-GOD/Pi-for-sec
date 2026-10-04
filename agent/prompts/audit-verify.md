---
description: Run evidence gate and adversarial cross-audit on current findings
argument-hint: "<runId> [finding ids or severity]"
---
Load the `security-audit` skill.

Verify findings for run `$1`. Target: ${@:2-all findings above low severity}

Steps:
1. Collect the findings from `./tmp/security-audit/$1/findings/`.
2. Order them: critical and high first, then medium with non-high confidence.
3. Run `/Users/zsm/.pi/agent/workflows/audit-verify.js` in batches of at most 16 lanes.
4. Read every evidence and cross artifact yourself. Then set the terminal status for each finding:
   - `confirmed` only with supported evidence and an unrefuted cross-audit
   - `rejected` only with specific code evidence that refutes it
   - `uncertain` with a concrete statement of what would settle it
5. Send any genuine disagreement to `audit-arbiter`. Never average two opinions.
6. Report the status table and list what still needs runtime verification.

Do not advance a finding to `confirmed` on static reasoning if it has `needs_runtime: true` and runtime verification is in scope.
