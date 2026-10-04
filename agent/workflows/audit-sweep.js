// audit-sweep.js — parallel static audit over independent code blocks.
//
// Usage:
//   subagent({
//     workflowScriptPath: "/Users/zsm/.pi/agent/workflows/audit-sweep.js",
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

const runId = (args && args.runId) || "run";
const blocks = (args && args.blocks) || [];
const workspace = (args && args.workspace) || ("./tmp/security-audit/" + runId);
const defaultAgent = (args && args.defaultAgent) || "audit-static";
const extraInstructions = (args && args.instructions) || "";

if (!Array.isArray(blocks) || blocks.length === 0) {
  return { error: "args.blocks must be a non-empty array of block objects" };
}

const MAX_BLOCKS = 24;
const selected = blocks.slice(0, MAX_BLOCKS);
const skipped = blocks.slice(MAX_BLOCKS).map((b) => b.id || b.name || "unnamed");

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
          title: { type: "string" },
          category: { type: "string" },
          severity: { type: "string" },
          confidence: { type: "string" },
          status: { type: "string" },
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                symbol: { type: "string" }
              },
              required: ["file"],
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
        required: ["id", "title", "category", "severity", "confidence", "locations", "evidence"],
        additionalProperties: false
      }
    },
    clean_areas: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } }
  },
  required: ["block", "findings"],
  additionalProperties: false
};

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
  lines.push("- Every finding needs at least one evidence entry with a real file, real line and a real quote.");
  lines.push("- Set needs_runtime true with a precise runtime_question when only execution can settle it.");
  lines.push("- Report clean_areas for what you checked and found sound.");
  lines.push("- Return the structured findings object. No prose report.");
  return lines.join("\n");
}

emit("audit-sweep " + runId + ": dispatching " + selected.length + " blocks");

const launches = selected.map((block, index) => ({
  key: "block-" + (block.id || String(index)),
  label: "Audit " + (block.id || index) + " " + (block.name || ""),
  agent: block.agent || defaultAgent,
  task: buildTask(block),
  context: "fresh",
  output: workspace + "/findings/" + (block.id || ("B" + index)) + ".json",
  outputSchema: FINDINGS_SCHEMA
}));

const results = await runs.all(launches);

const report = results.map((result, index) => {
  const block = selected[index];
  const structured = result && result.structuredOutput ? result.structuredOutput : null;
  const findings = structured && Array.isArray(structured.findings) ? structured.findings : [];
  return {
    block_id: block.id || ("B" + index),
    block_name: block.name || "",
    agent: block.agent || defaultAgent,
    ok: !!(result && result.ok),
    finding_count: findings.length,
    needs_runtime: findings.filter((f) => f && f.needs_runtime === true).map((f) => f.id),
    severities: findings.map((f) => (f && f.severity) || "unknown"),
    findings: findings,
    coverage: structured ? structured.coverage : null,
    clean_areas: structured ? structured.clean_areas : null,
    open_questions: structured ? structured.open_questions : null,
    artifact: result ? result.outputReference : null,
    error: result && result.ok === false ? (result.output || "child failed") : null
  };
});

const total = report.reduce((sum, entry) => sum + entry.finding_count, 0);
emit("audit-sweep " + runId + ": " + total + " candidate findings across " + report.length + " blocks");

return {
  run_id: runId,
  workspace: workspace,
  blocks_audited: report.length,
  blocks_skipped: skipped,
  total_findings: total,
  failed_blocks: report.filter((entry) => !entry.ok).map((entry) => entry.block_id),
  runtime_questions: report.reduce((acc, entry) => acc.concat(entry.needs_runtime), []),
  results: report
};
