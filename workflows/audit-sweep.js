// audit-sweep.js — parallel static audit over independent code blocks.
//
// Usage:
//   subagent({
//     workflow: "/Users/zsm/.pi/agent/workflows/audit-sweep.js",
//     args: {
//       runId: "20260912-auth",
//       blocks: [
//         { id: "B01", name: "auth middleware", concern: "session + role checks",
//           paths: ["src/auth"], agent: "audit-authz", priority: "p0" }
//       ]
//     },
//     async: true
//   })
//
// Returns one entry per block with its structured findings and artifact path.
//
// Budget: every block child gets a hard 40-minute deadline and a checkpoint steer
// 5 minutes before it. A child that dies without a structured_output call is
// re-launched once as a rescue lane (no re-reading, output only). Anything still
// missing is reported as a timeout/deferred block, never as clean.

const runId = (args && args.runId) || "run";
const blocks = (args && args.blocks) || [];
const workspace = (args && args.workspace) || ("./tmp/security-audit/" + runId);
const defaultAgent = (args && args.defaultAgent) || "audit-static";
const extraInstructions = (args && args.instructions) || "";

// 40 min hard deadline, checkpoint (land the report) at 35 min.
const BLOCK_TIMEOUT_MS = (args && args.timeoutMs) || 2400000;
const CHECKPOINT_BEFORE_MS = (args && args.checkpointBeforeDeadlineMs) || 300000;
const RESCUE_TIMEOUT_MS = (args && args.rescueTimeoutMs) || 300000;
const rescue = (args && args.rescue) !== false;

if (!Array.isArray(blocks) || blocks.length === 0) {
  return { error: "args.blocks must be a non-empty array of block objects" };
}

const MAX_BLOCKS = 24;
const selected = blocks.slice(0, MAX_BLOCKS);
const skipped = blocks.slice(MAX_BLOCKS).map((b) => b.id || b.name || "unnamed");

// Field names and enums must match skills/security-audit/finding-schema.json,
// otherwise the sweep output fails validate-findings.cjs at the wave gate.
const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    block: { type: "string" },
    coverage: {
      type: "object",
      properties: {
        files_read: { type: "array", items: { type: "string" } },
        not_covered: { type: "array", items: { type: "string" } },
        limits: { type: "string" }
      },
      required: ["files_read"],
      additionalProperties: false
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          block: { type: "string" },
          fingerprint: { type: "string" },
          title: { type: "string" },
          category: {
            type: "string",
            enum: [
              "authn", "authz", "tenant", "injection", "deserialization", "path",
              "upload", "ssrf", "rce", "crypto", "secrets", "exposure", "logic",
              "race", "config", "dependency", "container", "cicd", "dos", "other"
            ]
          },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          status: {
            type: "string",
            enum: [
              "candidate", "needs-evidence", "evidence-reviewed", "cross-audited",
              "runtime-verified", "confirmed", "rejected", "uncertain", "duplicate",
              "approved-for-fix", "fixed", "reverified"
            ]
          },
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                symbol: { type: "string" }
              },
              required: ["file", "line"],
              additionalProperties: false
            }
          },
          flow: { type: "string" },
          impact: { type: "string" },
          preconditions: { type: "array", items: { type: "string" } },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                quote: { type: "string" }
              },
              required: ["file", "quote"],
              additionalProperties: false
            }
          },
          repro: { type: "string" },
          needs_runtime: { type: "boolean" },
          runtime_question: { type: "string" },
          existing_mitigations: { type: "string" },
          notes: { type: "string" }
        },
        required: [
          "id", "title", "category", "severity", "confidence", "status",
          "locations", "flow", "impact", "evidence"
        ],
        additionalProperties: false
      }
    },
    clean_areas: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } }
  },
  required: ["block", "findings"],
  additionalProperties: false
};

// Workflow keys must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ and be unique.
// Block ids are free text in practice, so sanitize instead of trusting them.
const usedKeys = Object.create(null);
function blockSlug(block, index) {
  const raw = String(block.id || ("B" + index));
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-{2,}/g, "-");
}

function blockKey(block, index) {
  const base = ("block-" + blockSlug(block, index)).slice(0, 120);
  let key = base;
  let n = 2;
  while (usedKeys[key]) key = base + "-" + n++;
  usedKeys[key] = true;
  return key;
}

function fmtMinutes(ms) {
  const minutes = ms / 60000;
  if (minutes >= 1) return Math.round(minutes) + " minutes";
  return Math.max(1, Math.round(ms / 1000)) + " seconds";
}

function buildTask(block) {
  const lines = [
    "Audit this block for security defects. Read-only. Do not run commands.",
    "",
    "Block id: " + (block.id || "B00"),
    "Block name: " + (block.name || ""),
    "Concern: " + (block.concern || "general security review"),
    "Priority: " + (block.priority || "p1"),
    "Paths in scope:",
    (block.paths || []).map((p) => "  - " + p).join("\n"),
    ""
  ];
  if (block.entrypoints && block.entrypoints.length > 0) {
    lines.push("Known entrypoints:");
    lines.push(block.entrypoints.map((e) => "  - " + e).join("\n"));
    lines.push("");
  }
  if (block.why) {
    lines.push("Why this block matters: " + block.why);
    lines.push("");
  }
  if (extraInstructions) {
    lines.push("Supervisor instructions: " + extraInstructions);
    lines.push("");
  }
  lines.push("Rules:");
  lines.push("- Stay inside the listed paths; read outside only to resolve a call or guard that changes your verdict.");
  lines.push("- Finding ids must use the prefix " + (block.id || "B00") + "-NN.");
  lines.push("- Set block to \"" + (block.id || "B00") + "\" on every finding.");
  lines.push("- status is always \"candidate\"; the supervisor advances it later.");
  lines.push("- flow is one line: entrypoint -> ... -> sink.");
  lines.push("- impact states what an attacker gains, assuming the preconditions hold.");
  lines.push("- category, severity and confidence must use the schema's exact enum values.");
  lines.push("- Every finding needs at least one evidence entry with a real file, real line and a real quote.");
  lines.push("- File paths in locations and evidence must be relative to the repository root, never absolute.");
  lines.push("- Set needs_runtime true with a precise runtime_question when only execution can settle it.");
  lines.push("- Report clean_areas for what you checked and found sound.");
  lines.push("- Return the structured findings object. No prose report.");
  lines.push("");
  lines.push("Deadline: this run is killed after " + fmtMinutes(BLOCK_TIMEOUT_MS) + " and you are told to land the");
  lines.push("report at the " + fmtMinutes(BLOCK_TIMEOUT_MS - CHECKPOINT_BEFORE_MS) + " mark. On the checkpoint steer, stop reading and emit");
  lines.push("structured_output immediately with an honest coverage.limits and the unfinished work in open_questions.");
  return lines.join("\n");
}

// A rescue child inherits the killed run's partial transcript. That transcript is often
// worthless — a timeout can land before the first finding, leaving only an opening line and
// runtime noise. So the rescue has two modes, and the prompt states which one applies instead
// of asking the child to reconcile "do not re-audit" with "there is nothing to convert".
function partialIsUsable(text) {
  if (typeof text !== "string") return false;
  const body = text.trim();
  if (body.length < 400) return false;
  // Runtime recovery summaries and bare git noise carry no audit reasoning.
  const noise = /Partial output before|Recovery summary:|git diff --no-index|warning: Not a git repository|警告：不是 git 仓库/i;
  const withoutNoise = body.replace(new RegExp(noise.source, "gi"), "").trim();
  return withoutNoise.length >= 400;
}

function buildRescueTask(block, previous) {
  const rawPartial = previous && typeof previous.output === "string" ? previous.output : "";
  const usable = partialIsUsable(rawPartial);
  const partial = usable
    ? rawPartial.trim().slice(0, 20000)
    : "(the killed run produced no usable audit reasoning — only runtime noise)";
  const lines = [
    "You are completing an audit of one block that ran out of time before returning a result.",
    usable
      ? "Work already done exists in the partial output below. Convert it; do not redo the audit."
      : "The killed run left nothing usable. You must audit the block yourself, but under a hard budget:",
    usable
      ? ""
      : "read the smallest set of files that covers the block's stated concern, then report. Do not trace",
    usable ? "" : "beyond the block. Partial but honest coverage is the expected outcome here.",
    "",
    "Block id: " + (block.id || "B00"),
    "Block name: " + (block.name || ""),
    "Concern: " + (block.concern || "general security review"),
    "Paths in scope:",
    (block.paths || []).map((p) => "  - " + p).join("\n"),
    "",
    usable
      ? "Partial output from the killed run follows. It is raw model text, not a verified report:"
      : "Partial output from the killed run follows (unusable; for reference only):",
    "treat every claim in it as unverified and re-check a citation with one read before relying on it.",
    "If you cannot confirm a citation cheaply, drop that finding rather than guess its line number.",
    "=== BEGIN PARTIAL OUTPUT ===",
    partial,
    "=== END PARTIAL OUTPUT ===",
    "",
    "Rules:",
    usable
      ? "- Spend at most a few reads, only to confirm citations you already have in hand."
      : "- Read only files inside the listed paths. Do not explore the wider repository.",
    "- Finding ids use the prefix " + (block.id || "B00") + "-NN.",
    "- Set block to \"" + (block.id || "B00") + "\" on every finding.",
    "- status is always \"candidate\".",
    "- Every finding needs at least one evidence entry with a real file, real line and real quote.",
    "- File paths in locations and evidence must be relative to the repository root, never absolute.",
    "- coverage.files_read must list only files actually read, including in the killed run.",
    "- coverage.limits must say this was a deadline rescue.",
    "- Put every unexamined area in open_questions, naming the file or symbol to audit next.",
    "- An empty findings array with honest coverage is a correct answer. Invented findings are not.",
    "- Return the structured findings object. No prose report."
  ];
  return lines.join("\n");
}

emit("audit-sweep " + runId + ": dispatching " + selected.length + " blocks");

const launches = selected.map((block, index) => ({
  key: blockKey(block, index),
  label: "Audit " + (block.id || index) + " " + (block.name || ""),
  agent: block.agent || defaultAgent,
  task: buildTask(block),
  context: "fresh",
  output: workspace + "/findings/" + blockSlug(block, index) + ".json",
  outputSchema: FINDINGS_SCHEMA,
  timeoutMs: BLOCK_TIMEOUT_MS,
  checkpointBeforeDeadlineMs: CHECKPOINT_BEFORE_MS
}));

const results = await runs.all(launches);

// A block is "lost" when the child settled without a contract-shaped result. Timeout is the
// common cause, but an empty terminal reply or a crashed child lands here too, and all three
// would otherwise be reported as zero findings — indistinguishable from a clean block.
function lostReason(result) {
  if (!result) return "no result object";
  if (result.ok === true && result.structuredOutput) return null;
  const outcome = result.terminalOutcome && result.terminalOutcome.reason;
  if (outcome === "timeout") return "deadline timeout";
  if (result.outputPartial) return "killed while streaming (deadline)";
  if (result.state === "running") return "child still running at workflow end";
  return "child failed without structured output";
}

const lost = results.map((result, index) => ({ result: result, index: index })).filter((entry) => lostReason(entry.result) !== null);

let rescued = [];
if (rescue && lost.length > 0) {
  emit("audit-sweep " + runId + ": " + lost.length + " block(s) need a deadline rescue");
  const rescueLaunches = lost.map((entry) => {
    const block = selected[entry.index];
    return {
      key: launches[entry.index].key + "-rescue",
      label: "Rescue " + (block.id || entry.index) + " " + (block.name || ""),
      agent: block.agent || defaultAgent,
      task: buildRescueTask(block, entry.result),
      context: "fresh",
      output: workspace + "/findings/" + blockSlug(block, entry.index) + ".rescue.json",
      outputSchema: FINDINGS_SCHEMA,
      timeoutMs: RESCUE_TIMEOUT_MS,
      checkpointBeforeDeadlineMs: Math.min(CHECKPOINT_BEFORE_MS, 60000)
    };
  });
  rescued = await runs.all(rescueLaunches);
  emit("audit-sweep " + runId + ": rescue finished");
}

const rescueByIndex = {};
lost.forEach((entry, position) => {
  rescueByIndex[entry.index] = { result: rescued[position], launch: launches[entry.index] };
});

const report = results.map((result, index) => {
  const block = selected[index];
  const rescueEntry = rescueByIndex[index];
  const primaryLost = lostReason(result);
  const source = primaryLost !== null && rescueEntry ? rescueEntry.result : result;
  const sourceLabel = primaryLost !== null && rescueEntry && rescueEntry.result && rescueEntry.result.ok === true && rescueEntry.result.structuredOutput
    ? "rescue"
    : primaryLost !== null ? "lost" : "primary";
  const structured = source && source.structuredOutput ? source.structuredOutput : null;
  const findings = structured && Array.isArray(structured.findings) ? structured.findings : [];
  const lost_after_rescue = primaryLost !== null && structured === null;
  return {
    block_id: block.id || ("B" + index),
    block_key: launches[index] ? launches[index].key : null,
    block_name: block.name || "",
    agent: block.agent || defaultAgent,
    ok: structured !== null,
    result_source: sourceLabel,
    lost_reason: primaryLost,
    finding_count: findings.length,
    needs_runtime: findings.filter((f) => f && f.needs_runtime === true).map((f) => f.id),
    severities: findings.map((f) => (f && f.severity) || "unknown"),
    findings: findings,
    coverage: structured ? structured.coverage : null,
    clean_areas: structured ? structured.clean_areas : null,
    open_questions: structured ? structured.open_questions : null,
    artifact: source ? source.outputReference : null,
    error: lost_after_rescue
      ? primaryLost
      : result && result.ok === false && structured === null ? (result.output || "child failed") : null
  };
});

const total = report.reduce((sum, entry) => sum + entry.finding_count, 0);
const lostBlocks = report.filter((entry) => !entry.ok);
emit("audit-sweep " + runId + ": " + total + " candidate findings across " + report.length + " blocks, " + lostBlocks.length + " lost");

return {
  run_id: runId,
  workspace: workspace,
  blocks_audited: report.length,
  blocks_skipped: skipped,
  total_findings: total,
  failed_blocks: report.filter((entry) => !entry.ok).map((entry) => entry.block_id),
  // These blocks produced no contract-shaped result at all. Record each one in the ledger as
  // failed/deferred with a reason; they are unknown, not clean, and must never be counted as
  // covered in the report.
  lost_blocks: lostBlocks.map((entry) => ({ block_id: entry.block_id, reason: entry.lost_reason || entry.error || "no structured output" })),
  rescued_blocks: report.filter((entry) => entry.result_source === "rescue").map((entry) => entry.block_id),
  runtime_questions: report.reduce((acc, entry) => acc.concat(entry.needs_runtime), []),
  results: report
};
