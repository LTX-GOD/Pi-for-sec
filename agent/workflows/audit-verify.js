// audit-verify.js — per-finding verification lanes: evidence gate, then adversarial cross-audit.
//
// Usage:
//   subagent({
//     workflowScriptPath: "/Users/zsm/.pi/agent/workflows/audit-verify.js",
//     args: { runId: "20260912-auth", findings: [ <finding objects> ] },
//     async: true
//   })
//
// One lane per finding. Lanes run in parallel; stages inside a lane run in order.
// A lane that fails its evidence stage skips the cross stage and reports it.

const runId = (args && args.runId) || "run";
const findings = (args && args.findings) || [];
const workspace = (args && args.workspace) || ("./tmp/security-audit/" + runId);
const skipCrossFor = (args && args.skipCrossFor) || ["low", "info"];

if (!Array.isArray(findings) || findings.length === 0) {
  return { error: "args.findings must be a non-empty array of finding objects" };
}

const MAX_LANES = 16;
const selected = findings.slice(0, MAX_LANES);
const deferred = findings.slice(MAX_LANES).map((f) => f.id || "unnamed");

function laneKey(finding, index) {
  const raw = String(finding.id || ("f" + index));
  return raw.replace(/[^A-Za-z0-9._-]/g, "-");
}

function findingBlock(finding) {
  return JSON.stringify(finding, null, 2);
}

function evidenceTask(finding) {
  return [
    "Verify whether this finding is supported by what is actually in the code.",
    "You are a gate, not an auditor. Do not hunt for new vulnerabilities.",
    "",
    "Check: citations resolve, the claimed flow is real, guards were not missed,",
    "preconditions are stated, severity matches impact, and the repro is concrete.",
    "",
    "Finding under review:",
    findingBlock(finding),
    "",
    "Return the reviewed JSON object with one entry for this finding id."
  ].join("\n");
}

function crossTask(finding) {
  return [
    "Independently try to REFUTE this finding. Read the code yourself first;",
    "do not treat the reported quotes as established fact.",
    "",
    "Test at least two real refutation hypotheses: broken flow link, unreachable path,",
    "framework or ORM protection, encoding at the boundary, disabled feature, wrong threat model.",
    "If you cannot refute it, sharpen it: set your own severity, confidence and impact,",
    "and report missed variants of the same defect.",
    "",
    "Finding under review:",
    findingBlock(finding),
    "",
    "Return the reviews JSON object with one entry for this finding id."
  ].join("\n");
}

const lanes = selected.map((finding, index) => {
  const key = laneKey(finding, index);
  const severity = String(finding.severity || "medium").toLowerCase();
  const stages = [
    {
      key: "evidence",
      label: "Evidence gate " + (finding.id || index),
      agent: "audit-evidence",
      task: evidenceTask(finding),
      context: "fresh",
      output: workspace + "/findings/verify/" + key + ".evidence.json"
    }
  ];
  if (skipCrossFor.indexOf(severity) === -1) {
    stages.push({
      key: "cross",
      label: "Cross audit " + (finding.id || index),
      agent: "audit-cross",
      task: crossTask(finding),
      context: "fresh",
      output: workspace + "/findings/verify/" + key + ".cross.json"
    });
  }
  return { key: key, stages: stages };
});

emit("audit-verify " + runId + ": " + lanes.length + " lanes");

const board = await runs.lanes(lanes);

const results = board.map((lane, index) => {
  const finding = selected[index];
  const stageMap = {};
  (lane.stages || []).forEach((stage) => {
    stageMap[stage.key] = {
      state: stage.state,
      ok: stage.ok,
      run_id: stage.runId,
      artifact: stage.outputReference || null,
      verdict: stage.verdict || null
    };
  });
  return {
    finding_id: finding.id || ("f" + index),
    lane_state: lane.state,
    failed_stage: lane.failedStage || null,
    severity_in: finding.severity || null,
    evidence: stageMap.evidence || null,
    cross: stageMap.cross || null,
    cross_skipped: !stageMap.cross,
    needs_supervisor: lane.state !== "complete"
  };
});

const blocked = results.filter((entry) => entry.needs_supervisor).map((entry) => entry.finding_id);
emit("audit-verify " + runId + ": " + (results.length - blocked.length) + " verified, " + blocked.length + " need attention");

return {
  run_id: runId,
  workspace: workspace,
  verified: results.length,
  deferred_findings: deferred,
  blocked_findings: blocked,
  results: results,
  next_step: "Read each artifact, set the terminal status, and send conflicts to audit-arbiter."
};
