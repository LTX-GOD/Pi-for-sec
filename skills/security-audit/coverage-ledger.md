# Coverage ledger

The ledger is the run's countable coverage record: what was audited, what was not, and why. It lives at `<workspace>/coverage-ledger.json`. The supervisor is its only writer — agents return coverage in their structured output, the supervisor records it in the ledger.

Coverage you cannot count is coverage you cannot defend. "We looked at the auth area" is not a coverage claim; "B01 covered by audit-authz (4 files, 2 sub-paths not covered), B04 deferred: agent budget spent, B07 out_of_scope: user excluded vendored SDK" is.

## Structure

```json
{
  "run_id": "20260912-auth",
  "target": "/absolute/path/to/repo",
  "source_ref": "a1b2c3d",
  "scope": {
    "in_scope": ["src/"],
    "out_of_scope": ["vendor/", "docs/"]
  },
  "prior_runs": [{ "path": "./tmp/security-audit/20260801-auth" }],
  "blocks": [
    {
      "block_id": "B01",
      "name": "auth middleware",
      "paths": ["src/auth", "src/middleware"],
      "agent": "audit-authz",
      "status": "covered",
      "findings": ["B01-01"],
      "coverage": { "files_read": ["src/auth/session.ts"], "not_covered": ["src/auth/legacy.rs"], "limits": "framework middleware resolved from registration only" },
      "reason": null
    },
    {
      "block_id": "B04",
      "name": "webhook signing",
      "paths": ["src/webhooks"],
      "agent": null,
      "status": "deferred",
      "findings": [],
      "coverage": null,
      "reason": "agent budget spent in wave 2; schedule for next pass"
    }
  ]
}
```

## Block statuses

| status | meaning |
|---|---|
| `planned` | mapped, not yet assigned |
| `in_progress` | assigned to a running agent |
| `covered` | an agent audited it and returned coverage (findings may be zero) |
| `candidate` | covered and produced at least one live finding |
| `deferred` | deliberately not covered this pass — **requires `reason`** |
| `failed` | agent ran but returned nothing usable (error, timeout, empty) — **requires `reason`** |
| `out_of_scope` | user excluded it — **requires `reason`** |

## Rules

- Every path in `scope.in_scope` must have at least one block covering it, and every block path must sit inside the scope. A gap is either a missing block or a wrong scope — never silence.
- `covered`/`candidate` blocks require a `coverage` object with a non-empty `files_read`. "Covered" without read files is not coverage.
- A finding belongs to exactly one block. Terminal findings (`confirmed`/`rejected`/`uncertain`/`duplicate`) must sit on blocks that are `covered` or `candidate`.
- Update the ledger after every wave, before and after runtime verification, and at the end. Budget spent is not coverage: unassigned planned blocks become `deferred` with the reason, in the ledger, where the report can see them.

## Prior-run carry (re-audits)

Rules adapted from Cloudflare's security-audit-skill, which measured that a single run finds roughly half of what repeated runs find:

1. A prior `confirmed` finding carries into the current run only when its cited source is unchanged — compare the actual lines, not just the commit ref. A carried finding re-enters as `candidate` on a `planned` revalidation block and goes through the same evidence/cross gates as new work. Never auto-confirm from history.
2. Changed source under a prior finding is a planned revalidation block, not a carried confirmation.
3. Prior `uncertain`, `deferred`, and `failed` blocks are current work. They never suppress current coverage.
4. A prior `rejected` finding suppresses only its own unchanged claim, never the block it came from.
5. Audit memory (MEMORY.md) informs priority, never coverage. "Prior run was clean" is not a finding.
6. Match findings across runs by `fingerprint` (root cause), not by title or id — titles drift, root causes do not.

## End-of-run coverage statement

The report's first section states, derived from the ledger: N blocks covered, M deferred with reasons, K out_of_scope, and what the run did not establish. Never "fully audited". A scoped run (single subsystem, diff-only) must present itself as partial coverage.

## Validation gate

Run after every ledger update and at the end of the run:

```bash
node /Users/zsm/.pi/agent/skills/security-audit/validate-coverage-ledger.cjs \
  <workspace>/coverage-ledger.json <workspace>/findings
```

The optional findings argument (file or directory) cross-checks the ledger against the findings collection. A run ends in one of exactly two states: (a) report + findings.json + ledger written and both validators pass, or (b) incomplete, with the gaps disclosed in the report's first section.
