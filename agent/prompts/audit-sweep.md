---
description: Dispatch parallel block auditors for the current audit run
argument-hint: "<runId> [block ids or paths]"
---
Load the `security-audit` skill.

Run a static audit wave for run `$1` over: ${@:2}

Steps:
1. Resolve the blocks. Use the existing block map at `./tmp/security-audit/$1/scope/` if present; otherwise derive blocks from the paths I gave and show them to me first.
2. Tag each block with the right specialist: `audit-authz`, `audit-input`, `audit-config`, or `audit-static`.
3. Dispatch with `/Users/zsm/.pi/agent/workflows/audit-sweep.js`, 4–6 blocks per wave, p0 first.
4. When the wave returns, report: findings per block, severity spread, coverage gaps, and every `needs_runtime` question.
5. Recommend the next wave or the next stage. Do not auto-start verification.

Every finding must carry file, line and a real quote. Reject thin findings back to the auditor instead of passing them downstream.
