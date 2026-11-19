# Playbooks

Concrete run shapes. Pick the smallest one that answers the user's question.

## 1. Quick triage (15–30 min, static only)

Goal: tell the user where the risk concentrates, not everything that is wrong.

```
audit-navigator (block budget 8)
  -> pick the 3-4 p0 blocks
  -> audit-sweep.js on those blocks
  -> audit-evidence on high/critical only
  -> report inline, no synthesizer
```

Stop after the first sweep. Offer a deeper pass instead of silently starting one.

## 2. Full static audit

```
audit-navigator (block budget 12-20)
  -> confirm scope and threat model with the user
  -> seed coverage-ledger.json from the navigator block map
  -> audit-sweep.js in waves of 4-6 blocks, p0 first
  -> after each wave: update the ledger (statuses, findings refs, deferred reasons),
     validate it, adjust the next wave
  -> audit-verify.js on everything above low
  -> audit-arbiter on conflicts and stuck uncertain findings
  -> validate-findings.cjs on <workspace>/findings
  -> audit-synthesizer -> report.md + findings.json
  -> validate both gates (findings.json + ledger); anything unfinished stays
     in the ledger and the report's first section, never silently dropped
```

Between waves, ask yourself: did the last wave change the map? New entrypoint, new trust boundary, or a systemic pattern means the remaining blocks should be re-tagged before dispatch.

## 3. Static + runtime verification

```
static audit as above
  -> collect every needs_runtime question
  -> if >= 3 questions and Docker is permitted:
       audit-environment (start, health check, two tenants, manifest)
       audit-runtime-batch.js (serial)
       audit-environment (teardown)
  -> merge runtime verdicts into finding status
  -> validate-findings.cjs + validate-coverage-ledger.cjs
  -> audit-synthesizer
```

Do not start the environment for one question you can settle by reading. Do not leave it running after the batch.

## 4. Single finding, full verification

The cheapest high-value loop. Use it when the user pastes a suspicion.

```
audit-static or the matching specialist on the exact file
  -> audit-evidence
  -> audit-cross
  -> if they disagree: audit-arbiter
  -> if needs_runtime and approved: audit-environment + audit-runtime
  -> report the single finding with its evidence chain
```

## 5. Diff / PR audit

```
read the diff yourself, derive blocks from changed files
  -> audit-sweep.js with blocks scoped to the changed paths
     + instructions: "only report defects introduced or exposed by this diff"
  -> audit-evidence on everything
  -> audit-cross on high/critical
  -> short report: introduced, exposed, pre-existing-but-touched
```

Keep pre-existing issues in a separate section so the diff verdict stays readable.

## 6. Remediation loop

Only after findings are `confirmed` and the user approved the fix.

```
for each approved finding, one at a time:
  audit-fixer (fresh context, one finding)
    -> read the fix report
    -> audit-cross or audit-evidence on the diff: does the attack path actually break?
    -> if it had a runtime repro: audit-runtime re-verification against a fresh environment
    -> mark reverified
```

Never batch several fixes into one agent. Never let the fixer declare its own fix verified.

## 7. Re-audit after time passes

```
read ./.pi/agent-memory/security-audit/MEMORY.md (curated by audit-synthesizer)
  -> read the prior run's coverage-ledger.json + findings.json if present:
       match prior findings by fingerprint, not title or id
       unchanged prior confirmations re-enter as candidates on planned
       revalidation blocks (never auto-confirmed from history)
       changed source under a prior finding is a new revalidation block
       prior uncertain/deferred blocks are current work, not coverage
  -> audit-navigator with the previous block map as input: what changed?
  -> sweep only changed and previously deferred blocks
  -> re-verify previously uncertain findings first
```

This is where the memory pays off: past false-positive patterns and confirmed-clean areas keep the next run cheap. The ledger keeps it honest: a fingerprint is only "already found" if its cited lines are unchanged.

## Task text that works

Bad: *"Audit the authentication."*

Good:

```
Block B01, auth middleware. Paths: src/middleware/auth.ts, src/auth/session.ts.
Attacker: an authenticated low-privilege user of another tenant.
Question: can a request reach a protected handler without a verified session,
or with a session belonging to a different tenant?
Add the relevant attack-classes sections (including the domain's Core
discipline) as your hunting lens.
Cite file and line for every claim. Mark needs_runtime where only execution settles it.
```

Always give: block id, exact paths, the attacker, the question, a domain lens, and the evidence bar.

## Steering examples

- drifting: *"Stay inside B03. Record other areas as open_questions instead of auditing them."*
- thin evidence: *"B03-02 has no line citation for the sink. Add the exact file and line or drop the finding."*
- over-reporting: *"Drop generic hardening suggestions. Only defects with a demonstrated path."*
- stuck: *"Stop tracing the framework internals. Mark confidence medium, record the unresolved layer, and return."*

## Budget defaults that behave well

| Setting | Starting value |
|---|---|
| blocks per wave | 4–6 |
| total blocks per pass | 12–20 |
| verification lanes per call | 8–16 |
| runtime questions per batch | ≤ 10, serial |
| `maxSubagentSpawnsPerRun` | 64 (default) is enough for one pass |
| environment lifetime | one batch, then teardown |

If a pass needs more than this, it is two passes.
