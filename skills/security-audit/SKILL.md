---
name: security-audit
description: Orchestrate an adaptive multi-agent code security audit with pi-subagents — scope mapping, parallel block audits, Docker runtime verification, evidence gating, adversarial cross-audit and consolidated reporting. Use when the user asks to audit code for vulnerabilities, run a security review, verify findings, or coordinate audit subagents.
metadata:
  version: "1.1.0"
  requires: pi-subagents
---

# Security Audit Orchestration

You are the **supervisor**. The audit agents are capabilities, not a pipeline. You decide what runs, in what order, how many times, and when to stop.

Never hand the whole audit to one fixed workflow and walk away. Workflows are for mechanical fan-out; routing, escalation and stopping are yours.

## The roles

| Agent | Use it for | Writes? |
|---|---|---|
| `audit-navigator` | Map stack, entrypoints, trust boundaries, split into blocks | no |
| `audit-static` | General audit of one block | no |
| `audit-authz` | Authn/authz/tenant/IDOR specialist | no |
| `audit-input` | Injection, deserialization, path, upload, SSRF, RCE specialist | no |
| `audit-config` | Config, secrets, deps, container, CI/CD | no |
| `audit-environment` | Owns the isolated Docker environment | yes (workspace only) |
| `audit-runtime` | Dynamic verification of one question | no (bash, read-only to source) |
| `audit-evidence` | Gate: do citations and flows hold up | no |
| `audit-cross` | Adversarial refutation and missed variants | no |
| `audit-arbiter` | Settle disagreements and stuck `uncertain` findings | no |
| `audit-synthesizer` | Final report, dedup, ranking, memory curation | workspace/report only |
| `audit-fixer` | Implement one approved remediation | yes (code) |

Only `audit-environment` may touch Docker. Only `audit-fixer` may change source, and only after explicit approval.

## Deadline discipline

Every audit agent runs with a **40-minute hard deadline** and a **35-minute report checkpoint**
(`timeoutMs: 2400000`, `checkpointBeforeDeadlineMs: 300000`). The runner steers
`Deadline checkpoint from the runner` five minutes before the kill; each agent prompt tells it to
stop reading and emit its structured output at that point.

The checkpoint is a *soft* guarantee: a steer cannot land inside a long tool call, so a child can
still be killed with nothing. Three rules follow, and they are not negotiable:

1. **A lost child is never a clean block.** No `structured_output` means unknown coverage. It is
   `failed` (or `deferred`) in the ledger with `reason` naming the deadline. A report that counts a
   timed-out block as "no findings" is wrong and must not ship.
2. **The workflows rescue automatically.** `audit-sweep.js`, `audit-verify.js` and
   `audit-runtime-batch.js` each detect a child that settled without a contract-shaped result and
   re-launch it once with a narrow "convert what you already have" task. Read `lost_blocks`,
   `lost_stages` and `no_verdict` in their return value: anything still listed there failed twice and
   needs your decision.
3. **A rescue never lowers a gate.** Rescued findings are still `candidate` and still owe
   `audit-evidence` and `audit-cross`. A rescued evidence stage may legitimately answer
   `insufficient`; a rescued runtime probe may legitimately answer `inconclusive`. Neither may be
   promoted to `confirmed`, and `inconclusive` must not be read as "not reproducible".

When you dispatch a block yourself instead of through a workflow, pass the same budget:
`options: { timeoutMs: 2400000, checkpointBeforeDeadlineMs: 300000 }`.

## Run bootstrap

At the start of every audit:

1. Confirm the cwd is the target repository, not a config directory.
2. Pick a short `runId` (e.g. `20260912-auth`). Use it everywhere.
3. Create the workspace: `./tmp/security-audit/<runId>/` with `scope/`, `findings/`, `evidence/`, `env/`, `report/`.
4. Agree the **audit contract** with the user before spending budget:
   - target scope and what is explicitly out of scope
   - threat model: who is the attacker, what do they already have
   - depth: static-only, or static + runtime verification
   - whether Docker may be started
   - block budget, agent budget, and whether fixes are in scope
5. Bind durable outputs on every launch (`output:`), do not ask agents to invent filenames.
6. Seed `<workspace>/coverage-ledger.json` from the navigator's block map (see `coverage-ledger.md`). For single-block dispatches, a one-block ledger still beats none. You are the ledger's only writer; update it after every wave.

If the user gives a narrow target ("audit this upload handler"), skip recon and dispatch the specialist directly. Do not run the full machine for a small question.

## Dispatch policy

Route on signal, not on ceremony.

| Signal in the block | Send to |
|---|---|
| Routes, middleware, guards, sessions, tokens, tenant scoping | `audit-authz` |
| Query building, shell/exec, file paths, uploads, parsers, HTTP clients, templates | `audit-input` |
| Dockerfiles, compose, CI workflows, manifests, env/config, secrets | `audit-config` |
| Mixed or unclear concern, or a block that is mostly business logic | `audit-static` |
| A question only execution can answer | `audit-environment` then `audit-runtime` |

Rules:
- One block, one agent, one run. Blocks must be independent so they can run in parallel.
- If a block is too large, split it rather than raising the agent's budget.
- Run 2 specialists on the same block only when it genuinely has two concerns (e.g. an upload endpoint behind auth). Give each a different lens in the task text so they do not duplicate.
- Give every block a hunting lens from `attack-classes.md`: paste the matching sections — including the domain's "Core discipline" of what is *not* a finding — into the task text. A Rust FFI block gets memory-safety classes; an MCP server gets the AI/LLM classes; ordinary web logic gets the general set.
- Prefer `audit-static` when in doubt; promote to a specialist when the first pass shows the block is dense in that concern.

## Finding lifecycle

Every finding carries a status. You advance it; agents only propose.

```
candidate
  -> evidence-reviewed      (audit-evidence: citations and flow hold)
  -> needs-evidence         (back to the auditor with a precise question)
  -> cross-audited          (audit-cross could not refute it)
  -> runtime-verified       (audit-runtime reproduced it)
  -> confirmed | rejected | uncertain
  -> approved-for-fix -> fixed -> reverified
```

Gate rules:

- Nothing reaches `confirmed` without passing `audit-evidence`.
- Every `critical` and `high` gets `audit-cross`. Always. No exceptions for "obvious" bugs.
- `medium` gets cross-audit when confidence is not `high`, or when it crosses a trust boundary.
- `low`/`info` normally skip cross-audit; batch them into the report.
- A finding with `needs_runtime: true` may not be `confirmed` on static reasoning alone if runtime verification was in scope and the environment is available.
- Conflict between `audit-cross` and the original, or between static and runtime → `audit-arbiter`. Never average two opinions yourself.
- `uncertain` is a valid terminal state. Record what would settle it. Do not launch a third cross-auditor hoping for agreement.

## Verification tiers

Pick the cheapest tier that settles the question:

1. **Static-decisive** — the code alone proves it. No runtime needed.
2. **Static + second reader** — `audit-cross` settles it.
3. **Runtime-decisive** — needs the environment. Batch these: collect all `needs_runtime` questions first, start the environment once, then run verification agents against it.
4. **Undecidable locally** — depends on deployment facts outside the repo. Mark `uncertain`, list the fact needed, move on.

Never start Docker for a single question you could settle by reading two files. Never refuse to start Docker when five high findings are blocked on it.

## Machine validation gates

Two zero-dependency validators turn the finding contract and the coverage ledger into checkable facts. You run them — audit agents have no shell, and the synthesizer's prose is not proof.

After every ledger update (each wave, after runtime verification, and at the end):

```bash
node /Users/zsm/.pi/agent/skills/security-audit/validate-coverage-ledger.cjs \
  ./tmp/security-audit/<runId>/coverage-ledger.json ./tmp/security-audit/<runId>/findings
```

Before accepting any terminal status and after the synthesizer writes the report:

```bash
node /Users/zsm/.pi/agent/skills/security-audit/validate-findings.cjs \
  ./tmp/security-audit/<runId>/report/findings.json
```

The findings validator enforces the contract's hard rules: `confirmed` needs supported evidence review plus a cross-audit verdict (or an explicit low/info skip) plus an explicit runtime decision when `needs_runtime` is true; `rejected` needs refutation; `uncertain` needs a stated settling fact; ids are unique; at most one live finding per fingerprint. The ledger validator enforces countable coverage: every in-scope path has a block, covered blocks have read files, deferred work has a reason, and the ledger and findings collections agree.

Neither validator can see a timeout. Before you run them, reconcile the workflow's `lost_blocks`,
`lost_stages` and `no_verdict` lists into the ledger yourself: each entry becomes a `failed` or
`deferred` block with a `reason`, and a finding whose gate was lost must not be carrying a terminal
status.

A run ends in one of exactly two states: (a) report + findings.json + coverage-ledger.json written and both validators pass, or (b) incomplete, recorded in the ledger (`deferred`/`failed` with reasons) and disclosed in the report's first section. Never "we looked at everything". Never stop mid-phase.

## Parallelization

- 1 question → direct `subagent({ agent, task })`.
- N independent blocks → one `workflow` call with `runs.all`.
- N findings each needing `evidence → cross` → `runs.lanes`, one lane per finding.
- Anything where your next decision depends on the result → run the stage, read it, then decide. Do not encode your judgment into a mega-script.

Ready-made scripts (pass as `workflow`, absolute path — a value containing `/` is read as a file):

- `/Users/zsm/.pi/agent/workflows/audit-sweep.js` — parallel block audit
- `/Users/zsm/.pi/agent/workflows/audit-verify.js` — per-finding evidence + cross lanes
- `/Users/zsm/.pi/agent/workflows/audit-runtime-batch.js` — batched runtime verification

See `workflow-usage.md` for arguments and expected output.

Keep concurrency sane: 4–6 static auditors at once is usually right. Runtime agents against one shared environment should be serialized unless each has isolated data.

## Budget and stop conditions

Declare before starting, enforce while running:

- max blocks in this pass
- max total child agents
- max runtime verifications
- wall-clock or token ceiling (`usageBudget`, `timeoutMs`, `maxSubagentSpawnsPerRun`)

Stop a pass when any is true:
- the block budget is spent — report coverage honestly and offer a second pass
- two consecutive blocks return zero findings and zero new leads in an area already covered
- the environment cannot be brought up and every remaining question is runtime-bound
- the user's actual question has been answered

Do not keep spawning agents to look busy. An audit that says "these 6 blocks, these 4 confirmed findings, these 9 areas not covered" is more useful than one that pretends to be exhaustive.

## Supervising running agents

- Watch `/subagents-fleet` or ask for status. Do not re-dispatch a task that is already running.
- Steer instead of restarting when an agent drifts: send the narrow correction ("stay in the assigned block; cite file and line for every claim").
- The intercom bridge is active: agents will ask you for decisions. Answer promptly and specifically. Unanswered escalations are the main cause of stalled audits.
- Approve Docker privilege requests explicitly or deny them. Never let an agent self-approve.
- When an agent returns thin output, send it back with the exact missing item, not "please improve".

## Adapting the system

When the target does not fit the existing roles:

- **Unfamiliar stack** — do not invent a new agent immediately. Give `audit-static` a lens in the task text ("this is a Rust actix service; focus on extractor boundaries and unsafe blocks").
- **Recurring specialized need** — create a new agent file in `~/.pi/agent/agents/audit/` copying the shape of `audit-input.md`. Keep it read-only unless it truly needs execution.
- **Project-specific rules** — put them in the repo's `.pi/agents/` to override, or record durable knowledge in audit memory via `audit-synthesizer`.
- **Repeated false positives** — record the framework behavior in memory so the next run starts smarter. This is what makes the system improve across audits.

## Anti-patterns

- Running the full pipeline on a one-file question.
- Letting a read-only auditor start containers.
- Accepting a finding with no file:line evidence.
- Treating cross-audit agreement as proof when both agents read the same summary instead of the code.
- Fixing before confirming.
- Reporting "no issues found" when the truth is "3 blocks audited, 12 deferred".
- Treating a timed-out child as a clean block, or reading a rescue's `inconclusive` as "not reproducible".
- Confirming a finding whose evidence or cross-audit stage was lost, because the block budget ran out.
- Giving an agent a deadline without a checkpoint, then blaming it for returning nothing.
- Encoding the whole audit in one script and losing the ability to adapt mid-run.
- A report whose prose disagrees with findings.json, or that ships without both validators passing.
- Confirming from history: a prior `confirmed` finding is only carried after its cited source is re-checked and it re-enters the current gates.

## References

- `finding-contract.md` — the finding JSON, fingerprints, statuses, severity/confidence rules, and the machine-validation contract
- `coverage-ledger.md` — the run's countable coverage record, block statuses, and prior-run carry rules
- `attack-classes.md` — domain hunting knowledge (ported from Cloudflare's security-audit-skill) and how to route it into block tasks; the knowledge itself is in `attack-classes/`
- `docker-policy.md` — environment isolation, allowed and forbidden operations
- `workflow-usage.md` — the three workflow scripts, arguments and outputs
- `playbooks.md` — concrete run recipes: quick triage, full audit, single-finding verification, remediation loop
- `validate-findings.cjs` / `validate-coverage-ledger.cjs` — the two validation gates (with `*.test.cjs` suites; `node --test validate-findings.test.cjs validate-coverage-ledger.test.cjs`)
- `finding-schema.json` — the documented shapes behind the findings validator
