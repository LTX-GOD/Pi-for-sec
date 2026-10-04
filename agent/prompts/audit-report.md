---
description: Consolidate the audit run into a final report and update audit memory
argument-hint: "<runId>"
---
Load the `security-audit` skill.

Consolidate run `$1`.

Steps:
1. Gather everything under `./tmp/security-audit/$1/`: block findings, evidence reviews, cross-audits, runtime verdicts, arbitration rulings and the environment manifest.
2. Resolve every finding to a terminal status first. If anything is still mid-flight, tell me before writing the report.
3. Launch `audit-synthesizer` with the full input set. It must:
   - apply the latest status per finding, never a superseded one
   - deduplicate by root cause, keeping all locations
   - rank by real risk: reachability, privileges, blast radius, data sensitivity
   - keep confirmed and uncertain findings strictly separate
   - state coverage honestly, including what was deferred and why
   - write `report.md` and `findings.json` into the run workspace
   - append only durable, credential-free knowledge to audit memory
4. Show me the risk table, the coverage section and the recommended next steps.
5. Remind me of any environment still running and any finding waiting on a deployment fact.

Do not let the synthesizer introduce findings no agent reported, and do not upgrade confidence beyond the evidence.
