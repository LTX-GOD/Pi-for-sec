# Workflow usage

Three scripts cover the mechanical fan-out. Everything else stays in your hands as direct `subagent` calls.

Validate any script before first use:

```js
subagent({ action: "validate", workflow: "/Users/zsm/.pi/agent/workflows/audit-sweep.js" })
```

## audit-sweep.js — parallel block audit

```js
subagent({
  workflow: "/Users/zsm/.pi/agent/workflows/audit-sweep.js",
  args: {
    runId: "20260912-auth",
    blocks: [
      { id: "B01", name: "auth middleware", concern: "session validation and role checks",
        paths: ["src/auth", "src/middleware/auth.ts"], agent: "audit-authz", priority: "p0" },
      { id: "B02", name: "order API", concern: "tenant scoping on order reads",
        paths: ["src/api/orders.ts", "src/repo/orders.ts"], agent: "audit-authz", priority: "p0" },
      { id: "B03", name: "file upload", concern: "path handling and content type trust",
        paths: ["src/upload"], agent: "audit-input", priority: "p1" }
    ],
    instructions: "Treat any authenticated user as the attacker."
  },
  async: true
})
```

| Arg | Meaning |
|---|---|
| `runId` | Names the workspace `./tmp/security-audit/<runId>/` |
| `blocks[]` | `id`, `name`, `concern`, `paths[]`, `agent`, `priority`, optional `entrypoints[]`, `why` |
| `defaultAgent` | Used when a block omits `agent` (default `audit-static`) |
| `instructions` | Extra supervisor guidance appended to every block task |
| `workspace` | Override the artifact directory |
| `timeoutMs` | Hard per-block deadline. Default `2400000` (40 min) |
| `checkpointBeforeDeadlineMs` | When the child is told to land its report. Default `300000` (35 min mark) |
| `rescueTimeoutMs` | Deadline for a rescue child. Default `300000` |
| `rescue` | Set `false` to disable the automatic rescue pass |

Caps at 24 blocks per call and reports the rest under `blocks_skipped`.

Returns per block: `block_key`, `ok`, `result_source` (`primary`/`rescue`/`lost`), `lost_reason`,
`finding_count`, `findings[]`, `coverage`, `clean_areas`, `needs_runtime[]`, `artifact`.
Findings land as JSON at `<workspace>/findings/<blockId>.json`, where `<blockId>` is the block id
sanitized to `[A-Za-z0-9._-]` (a block id with spaces or slashes cannot become a workflow key, so
the key and filename are slugged and de-duplicated). A rescued block writes
`<blockId>.rescue.json` next to it.

**Deadline behaviour.** Every block child gets `timeoutMs` + `checkpointBeforeDeadlineMs` and is told
to emit `structured_output` at the checkpoint. A block whose child settles without a contract-shaped
result is re-launched once with a rescue task that converts the killed run's partial transcript into
findings without re-auditing. Blocks still without output appear in `lost_blocks` with a `reason`
and in the per-block `ok: false`; they must be recorded in the ledger as `failed`/`deferred`. A lost
block is **unknown coverage, never a clean block**.

Findings are written contract-shaped: `status` is always `candidate`, `flow` and `impact` are required, and `category`/`severity`/`confidence` use the enums from `finding-schema.json`. That means the swept block files pass the gate as-is — no hand-reshaping before `validate-findings.cjs`.

Next step: feed `runtime_questions` to the environment decision, and feed findings to `audit-verify.js`.

## audit-verify.js — evidence gate + cross audit

```js
subagent({
  workflow: "/Users/zsm/.pi/agent/workflows/audit-verify.js",
  args: {
    runId: "20260912-auth",
    findings: [ /* finding objects from the sweep */ ],
    skipCrossFor: ["low", "info"]
  },
  async: true
})
```

One lane per finding: `audit-evidence`, then `audit-cross` unless the severity is in `skipCrossFor`. Lanes run in parallel, stages in order. A failed evidence stage marks the cross stage `skipped` and the lane needs your attention.

Caps at 16 lanes per call. Batch high severity first.

Budget args match the sweep: `timeoutMs` (default 40 min), `checkpointBeforeDeadlineMs`
(default 35 min), `rescueTimeoutMs` (default 5 min), `rescue` (default on).

Returns per finding: `lane_state`, `failed_stage`, `evidence` and `cross` stage records (`state`, `ok`, `run_id`, `artifact`, `verdict`, `rescued`, `lost_reason`), `lost_stages`, and `needs_supervisor`. A stage `state` of `rescued` means the rescue child produced the verdict; `lost` means even the rescue failed.

**A lost stage is a failed gate.** The top-level `lost_stages` list names every
`<finding_id>:<stage>` that produced no verdict. Those findings have not passed the gate: they must
not reach `confirmed`, and a rescued evidence stage answering `insufficient` is a real result, not a
retry candidate. **The script does not set terminal status.** You read the artifacts and decide
`confirmed` / `rejected` / `uncertain`, routing conflicts to `audit-arbiter`.

## audit-runtime-batch.js — dynamic verification

Prerequisite: `audit-environment` reported `status: "ready"`.

```js
subagent({
  workflow: "/Users/zsm/.pi/agent/workflows/audit-runtime-batch.js",
  args: {
    runId: "20260912-auth",
    environment: {
      base_url: "http://127.0.0.1:18080",
      compose_project: "audit_20260912-auth",
      manifest: "./tmp/security-audit/20260912-auth/env/environment.json"
    },
    questions: [
      { finding_id: "B02-01", runtime_question: "Does a tenant-A session read a tenant-B order?",
        repro: "GET /api/orders/<tenant-B id> with tenant-A session" }
    ],
    parallel: false
  },
  async: true
})
```

Serial by default — probes sharing one environment interfere. Set `parallel: true` only when each question uses isolated data.

Caps at 20 questions. Returns `confirmed[]`, `blocked[]`, `no_verdict[]` and per-question artifacts under `<workspace>/evidence/`. Each verdict is structured (`verdict`, `recommended_status`, `confidence`, `verified_live`, `side_effects`); a question that ends without a structured verdict shows its prose under `output`.

Budget args match the sweep: `timeoutMs` (default 40 min), `checkpointBeforeDeadlineMs`
(default 35 min), `rescueTimeoutMs` (default 5 min), `rescue` (default on). A killed probe is
re-launched once with a task that says the expected answer is `inconclusive` plus the reason.

**`no_verdict` is not `not-reproducible`.** A question with no verdict proved nothing. The finding
keeps `needs_runtime: true`, stays out of `confirmed`, and the ledger records the runtime gate as
failed. Never close a finding because its probe ran out of time.

Always tear the environment down afterwards through `audit-environment`.

## Writing a one-off script instead

When your run does not match these shapes, write a short inline workflow rather than bending a stored one. Write the script as one ```` ```js workflow ```` fenced block in the reply, then call `subagent({ workflow: true, async: true })` in that same reply:

```js workflow
const scan = await runs.run("scan", { agent: "audit-navigator", task: "Map the auth surface" });
const audits = await runs.all([
  { key: "authz", agent: "audit-authz", task: "Audit access control using: " + scan.output },
  { key: "input", agent: "audit-input", task: "Audit input handling using: " + scan.output }
]);
return audits.map((r) => r.output);
```

The block is plain text, so nothing needs JSON escaping; a line of three or more backticks ends it. A reply carries one block and one call.

Sandbox rules that matter here:

- statement body, explicit `return`, top-level `await` allowed
- no nested `async function` / async arrow / async method helpers — plain helpers returning a promise are fine
- no filesystem, shell, network or Pi tools inside the script; all real work happens in the children
- always `await` (or `Promise.all` / `Promise.race`) every launched run
- `runs.all` returns an **ordered array**, not a key map
- keep returned values JSON-shaped

## Validation gates

The scripts produce artifacts; the validators make them checkable. Run both before treating a run as done (the supervisor runs these — agents have no shell):

```bash
node /Users/zsm/.pi/agent/skills/security-audit/validate-findings.cjs ./tmp/security-audit/<runId>/report/findings.json
node /Users/zsm/.pi/agent/skills/security-audit/validate-coverage-ledger.cjs \
  ./tmp/security-audit/<runId>/coverage-ledger.json ./tmp/security-audit/<runId>/findings
```

Notes:

- `validate-findings.cjs` accepts a single findings file or a directory of block files (the sweep's `<workspace>/findings/`). Use the directory form after every wave to catch contract drift early. A file may be a bare array or the sweep's `{ block, coverage, findings: [...] }` wrapper; wrapped entries get their `block` filled in when missing.
- The sweep's per-block `coverage` output feeds the ledger: record `files_read`, `not_covered`, and `limits` per block — the ledger validator rejects "covered" blocks with no read files.
- `blocks_skipped` from `audit-sweep.js` (over the 24-block cap) must land in the ledger as `deferred` blocks with a reason, not vanish.
- `lost_blocks` (sweep), `lost_stages` (verify) and `no_verdict` (runtime batch) are not covered work. Record each as `failed`/`deferred` with its reason before the validators run. The validators cannot detect a timeout, so this reconciliation is yours.
- Both validators exit 1 with all errors on stderr. A failing gate is a to-do list, not an obstacle: fix the records, re-run, then report.

## When not to use a workflow

- one question, one agent → direct `subagent({ agent, task })`
- your next decision depends on reading the result → run the stage, read it, decide
- fewer than three parallel children → the coordination overhead is not worth it
