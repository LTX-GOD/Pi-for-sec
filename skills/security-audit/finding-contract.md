# Finding contract

The shared data structure every audit agent speaks. Keep it stable — it is the only thing that makes cross-agent verification meaningful.

## Finding object

```json
{
  "id": "B03-02",
  "block": "B03",
  "fingerprint": "src/repo/orders.ts/findById-no-tenant-predicate",
  "title": "Order lookup accepts any order id without tenant scoping",
  "category": "tenant",
  "severity": "high",
  "confidence": "high",
  "status": "confirmed",
  "locations": [
    { "file": "src/api/orders.ts", "line": 88, "symbol": "getOrder" },
    { "file": "src/repo/orders.ts", "line": 41, "symbol": "findById" }
  ],
  "flow": "req.params.orderId -> getOrder() -> ordersRepo.findById(id) (no tenant predicate) -> row returned",
  "impact": "Any authenticated user can read any other tenant's order, including billing address and totals",
  "preconditions": ["authenticated session", "knows or can enumerate an order id"],
  "evidence": [
    { "file": "src/api/orders.ts", "line": 88, "quote": "const order = await ordersRepo.findById(req.params.orderId)" },
    { "file": "src/repo/orders.ts", "line": 41, "quote": "return db.select().from(orders).where(eq(orders.id, id))" }
  ],
  "repro": "Authenticate as tenant A, GET /api/orders/<id-owned-by-tenant-B>",
  "existing_mitigations": "authMiddleware applies to /api/*; no tenant predicate anywhere on this path",
  "needs_runtime": true,
  "runtime_question": "Does a tenant-A session receive a 200 with tenant-B order data?",
  "blocked_on": null,
  "duplicate_of": null,
  "verification": {
    "evidence_review": "supported",
    "cross_audit": "confirmed",
    "runtime": "confirmed",
    "arbitration": null
  },
  "remediation": "Scope the repository query by the session tenant id; add a tenant predicate at the repo layer, not the handler",
  "notes": ""
}
```

## Categories

`authn` `authz` `tenant` `injection` `deserialization` `path` `upload` `ssrf` `rce` `crypto` `secrets` `exposure` `logic` `race` `config` `dependency` `container` `cicd` `dos` `other`

## Severity

Impact-based, assuming the stated `preconditions` are met.

| Level | Meaning |
|---|---|
| `critical` | Unauthenticated remote code execution, full auth bypass, mass cross-tenant data access, credential compromise |
| `high` | Authenticated privilege escalation, cross-tenant read/write, injection with real data impact, secret exposure |
| `medium` | Constrained impact, requires elevated privileges, or needs an unlikely precondition |
| `low` | Limited or defense-in-depth issue with real but small consequence |
| `info` | Observation, hardening note, no demonstrated impact |

Reachability matters more than pattern severity. An unreachable `eval` is not critical. A one-line missing predicate on a hot path is.

## Confidence

| Level | Meaning |
|---|---|
| `high` | Full path traced, guards checked, evidence cited, or runtime-reproduced |
| `medium` | Path traced but at least one layer unverified; stated in `existing_mitigations` or `open_questions` |
| `low` | Pattern-level suspicion; must not be reported as confirmed |

Confidence and severity are independent. A `critical`/`low` finding is a legitimate output — it means "if real, this is severe; we could not verify it".

## Status

```
candidate            auditor proposed it
needs-evidence       evidence gate found the citations or flow insufficient
evidence-reviewed    citations and flow verified
cross-audited        adversarial reader could not refute it
runtime-verified     reproduced in the isolated environment
confirmed            terminal: real, evidenced, and (if required) reproduced
rejected             terminal: refuted with specific code evidence
uncertain            terminal for this pass: defensible both ways, or blocked on an exact
                     missing fact. Must state what settles it in blocked_on (external fact
                     not observable in the repo), runtime_question (executable question), or
                     notes. Uncertain is a blocked lead, never a low-confidence confirmed.
duplicate            merged into another finding id (set duplicate_of to the survivor)
approved-for-fix     human or supervisor approved remediation
fixed                remediation implemented
reverified           fix confirmed to break the attack path
```

Transition rules:

- Only the supervisor sets terminal statuses. Agents propose `next_status`.
- `rejected` requires evidence that refutes it. "Could not reproduce" alone is `uncertain`, not `rejected`.
- `confirmed` requires `evidence_review: supported` plus either `cross_audit: confirmed` or, for low-severity items, an explicit supervisor decision to skip cross-audit.
- Matching findings across blocks and runs is by `fingerprint`, never by title similarity. Titles drift; root causes do not.
- Reopening a `rejected` finding is allowed when new evidence appears; record why.

## Id scheme

`<blockId>-<nn>` for block findings (`B03-02`). Runtime-discovered variants get `<parentId>-v<n>` (`B03-02-v1`). Never renumber ids between passes — downstream reviews reference them.

## Evidence rules

- Every finding: at least one `evidence` entry with real `file`, real `line`, real `quote`.
- Multi-file flows: cite both the source and the sink.
- Quotes stay short and redacted; never paste credentials, tokens or full payloads.
- Runtime evidence lives in `./tmp/security-audit/<runId>/evidence/` and is referenced by path, not inlined wholesale.
- Evidence quotes are capped at 600 chars. Never paste credentials, tokens, or full payloads — the validator rejects overlong quotes.

## Fingerprints

A `fingerprint` is a stable source-derived identifier for the root cause: roughly `<defect-file>/<symbol>-<defect>`. It is not the title, not the id, and not the block.

- It survives every status change: the same fingerprint is `candidate`, then `confirmed`, then `approved-for-fix`, then `fixed`.
- Two live (non-duplicate) findings with the same fingerprint is a merge failure — the validator rejects the collection. Mark one `duplicate` with `duplicate_of`.
- Cross-run re-audits match prior findings by fingerprint (see `coverage-ledger.md`): unchanged source revalidates the same fingerprint; changed source is a new root-cause question.

Pattern: `^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$` (no spaces, no `#`).

## Machine validation

`finding-schema.json` documents the shapes; `validate-findings.cjs` is the authoritative checker and additionally enforces the rules a schema cannot express:

- `confirmed` requires `verification.evidence_review === "supported"`, `cross_audit === "confirmed"` (or `skipped` with low/info severity), and — when `needs_runtime` is true — an explicit `runtime` decision (`confirmed` / `not_required` / `out_of_scope`), not silence.
- `rejected` requires refuting evidence or notes. "Could not reproduce" alone is `uncertain`.
- `uncertain` requires `blocked_on`, `runtime_question`, or notes stating what settles it.
- `duplicate` requires a live `duplicate_of` target; ids are unique; at most one live finding per fingerprint.
- `verification` values are pinned enums:

| field | legal values |
|---|---|
| `evidence_review` | `supported` / `insufficient` / `refuted` / null |
| `cross_audit` | `confirmed` / `refuted` / `skipped` / null |
| `runtime` | `confirmed` / `refuted` / `blocked` / `not_required` / `out_of_scope` / null |
| `arbitration` | `upheld` / `overturned` / null |

Run it on per-block findings and on the final consolidated file (exit 1 = invalid, errors to stderr):

```bash
node /Users/zsm/.pi/agent/skills/security-audit/validate-findings.cjs ./tmp/security-audit/<runId>/findings   # dir of block files
node /Users/zsm/.pi/agent/skills/security-audit/validate-findings.cjs ./tmp/security-audit/<runId>/report/findings.json
```

The report is not done until this passes and the prose matches the JSON.

## Coverage object

Every auditing agent returns coverage alongside findings. An audit without coverage cannot be trusted:

```json
{
  "files_read": [],
  "not_covered": [],
  "limits": "dependency source not read; framework middleware resolved from registration only"
}
```
