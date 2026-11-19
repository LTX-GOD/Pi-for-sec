// audit-verify.js — per-finding verification lanes: evidence gate, then adversarial cross-audit.
//
// Usage:
//   subagent({
//     workflow: "/Users/zsm/.pi/agent/workflows/audit-verify.js",
//     args: { runId: "20260912-auth", findings: [ <finding objects> ] },
//     async: true
//   })
//
// One lane per finding. Lanes run in parallel; stages inside a lane run in order.
// A lane that fails its evidence stage skips the cross stage and reports it.
//
// Budget: every stage child gets a hard deadline and a pre-deadline checkpoint steer.
// A stage that dies without a contract-shaped verdict is retried once as a rescue child
// that only converts the killed run's partial reasoning into the verdict schema. A gate
// that still has no verdict stays blocked — it is never silently treated as "supported".

const runId = (args && args.runId) || "run";
const findings = (args && args.findings) || [];
const workspace = (args && args.workspace) || ("./tmp/security-audit/" + runId);
const skipCrossFor = (args && args.skipCrossFor) || ["low", "info"];

const STAGE_TIMEOUT_MS = (args && args.timeoutMs) || 2400000;
const CHECKPOINT_BEFORE_MS = (args && args.checkpointBeforeDeadlineMs) || 300000;
const RESCUE_TIMEOUT_MS = (args && args.rescueTimeoutMs) || 300000;
const rescue = (args && args.rescue) !== false;

if (!Array.isArray(findings) || findings.length === 0) {
  return { error: "args.findings must be a non-empty array of finding objects" };
}

const MAX_LANES = 16;
const selected = findings.slice(0, MAX_LANES);
const deferred = findings.slice(MAX_LANES).map((f) => f.id || "unnamed");

const usedLaneKeys = Object.create(null);
function laneKey(finding, index) {
  const raw = String(finding.id || ("f" + index));
  const slug = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "f-");
  const base = slug.slice(0, 120);
  let key = base;
  let n = 2;
  while (usedLaneKeys[key]) key = base + "-" + n++;
  usedLaneKeys[key] = true;
  return key;
}

function findingBlock(finding) {
  return JSON.stringify(finding, null, 2);
}

// Mirrors the verdict contracts in agents/audit/audit-evidence.md and audit-cross.md.
// `verdict` is hoisted to the top level so runs.lanes can read stage.verdict.
const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string" },
    verdict: { type: "string", enum: ["supported", "insufficient", "incorrect", "duplicate"] },
    next_status: { type: "string" },
    reviewed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          finding_id: { type: "string" },
          verdict: { type: "string" },
          citation_check: { type: "array", items: { type: "object", properties: { file: { type: "string" }, line: { type: "number" }, resolves: { type: "boolean" }, note: { type: "string" } } } },
          flow_check: { type: "string" },
          flow_note: { type: "string" },
          guard_found: { type: "string" },
          missing_evidence: { type: "array", items: { type: "string" } },
          severity_assessment: { type: "object", properties: { proposed: { type: "string" }, reason: { type: "string" } } },
          confidence_assessment: { type: "string" },
          preconditions_to_add: { type: "array", items: { type: "string" } },
          duplicate_of: { type: "string" },
          needs_runtime: { type: "boolean" },
          runtime_question: { type: "string" },
          next_status: { type: "string" }
        },
        required: ["finding_id", "verdict"]
      }
    },
    summary: { type: "object", properties: { supported: { type: "number" }, insufficient: { type: "number" }, incorrect: { type: "number" }, duplicate: { type: "number" } } },
    systemic_notes: { type: "array", items: { type: "string" } }
  },
  required: ["finding_id", "verdict", "reviewed"]
};

const CROSS_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string" },
    verdict: { type: "string", enum: ["confirmed", "rejected", "weakened", "strengthened", "uncertain"] },
    next_status: { type: "string" },
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          finding_id: { type: "string" },
          verdict: { type: "string" },
          independent_reading: { type: "string" },
          refutation_attempts: { type: "array", items: { type: "object", properties: { hypothesis: { type: "string" }, checked: { type: "string" }, result: { type: "string" } } } },
          decisive_evidence: { type: "array", items: { type: "object", properties: { file: { type: "string" }, line: { type: "number" }, quote: { type: "string" } } } },
          reachability: { type: "string" },
          reachability_note: { type: "string" },
          revised_severity: { type: "string" },
          revised_confidence: { type: "string" },
          revised_impact: { type: "string" },
          missed_variants: { type: "array", items: { type: "object", properties: { title: { type: "string" }, note: { type: "string" } } } },
          needs_runtime: { type: "boolean" },
          runtime_question: { type: "string" },
          next_status: { type: "string" },
          disagreement: { type: "string" }
        },
        required: ["finding_id", "verdict"]
      }
    },
    notes: { type: "array", items: { type: "string" } }
  },
  required: ["finding_id", "verdict", "reviews"]
};

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
    "Return the verdict via structured_output: the top-level `verdict` must be the",
    "single verdict for finding " + (finding.id || "") + ", and `reviewed` holds one",
    "entry for it. No prose report."
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
    "Return the verdict via structured_output: the top-level `verdict` must be the",
    "single verdict for finding " + (finding.id || "") + ", and `reviews` holds one",
    "entry for it. No prose report."
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
      output: workspace + "/findings/verify/" + key + ".evidence.json",
      outputSchema: EVIDENCE_SCHEMA,
      timeoutMs: STAGE_TIMEOUT_MS,
      checkpointBeforeDeadlineMs: CHECKPOINT_BEFORE_MS
    }
  ];
  if (skipCrossFor.indexOf(severity) === -1) {
    stages.push({
      key: "cross",
      label: "Cross audit " + (finding.id || index),
      agent: "audit-cross",
      task: crossTask(finding),
      context: "fresh",
      output: workspace + "/findings/verify/" + key + ".cross.json",
      outputSchema: CROSS_SCHEMA,
      timeoutMs: STAGE_TIMEOUT_MS,
      checkpointBeforeDeadlineMs: CHECKPOINT_BEFORE_MS
    });
  }
  return { key: key, stages: stages };
});

emit("audit-verify " + runId + ": " + lanes.length + " lanes");

const board = await runs.lanes(lanes);

// A stage that never produced a verdict is a lost gate, not a pass. Detect it from the
// lane board and re-run it once as a deliberately narrow rescue: the citations in hand,
// one read each, and a conservative verdict if they do not resolve.
function stageLost(stageRecord) {
  if (!stageRecord) return false;
  if (stageRecord.verdict) return false;
  return stageRecord.state !== "completed";
}

function rescueTask(kind, finding, previous) {
  const error = previous && previous.error ? String(previous.error).slice(0, 2000) : "(no error recorded)";
  const base = [
    "A previous " + kind + " child for this finding was killed before returning a verdict.",
    "Do the minimum needed to return a schema-valid verdict. Do not re-audit the block.",
    "",
    "Previous failure: " + error,
    ""
  ];
  if (kind === "evidence gate") {
    base.push(
      "Check only the citations this finding already claims: one read per cited file,",
      "look at the cited line. Do not look for new vulnerabilities.",
      "If a citation does not resolve or the flow does not hold, verdict \"insufficient\" or",
      "\"incorrect\" with a note. If you cannot check everything in the time you have,",
      "verdict \"insufficient\" and list what you could not check in missing_evidence.",
      "A conservative \"insufficient\" is a correct answer here; a guessed \"supported\" is not."
    );
  } else {
    base.push(
      "Read only the cited code and the guards immediately around it.",
      "If you cannot refute the finding from that, verdict \"uncertain\" and state in",
      "reachability_note exactly which file or fact would settle it.",
      "Do not confirm a finding you did not read yourself."
    );
  }
  base.push(
    "",
    "Finding under review:",
    findingBlock(finding),
    "",
    "Return the verdict via structured_output with the same shape the original stage owed.",
    "No prose report."
  );
  return base.join("\n");
}

const rescueTargets = [];
board.forEach((lane, laneIndex) => {
  (lane.stages || []).forEach((stage) => {
    if (!stageLost(stage)) return;
    rescueTargets.push({ laneIndex: laneIndex, stageKey: stage.key, stage: stage });
  });
});

let rescueResults = [];
if (rescue && rescueTargets.length > 0) {
  emit("audit-verify " + runId + ": " + rescueTargets.length + " lost stage(s), rescuing");
  const rescueLaunches = rescueTargets.map((target) => {
    const finding = selected[target.laneIndex];
    const key = laneKey(finding, target.laneIndex);
    const isEvidence = target.stageKey === "evidence";
    return {
      key: key + "." + target.stageKey + ".rescue",
      label: "Rescue " + target.stageKey + " " + (finding.id || target.laneIndex),
      agent: isEvidence ? "audit-evidence" : "audit-cross",
      task: rescueTask(isEvidence ? "evidence gate" : "cross audit", finding, target.stage),
      context: "fresh",
      output: workspace + "/findings/verify/" + key + "." + target.stageKey + ".rescue.json",
      outputSchema: isEvidence ? EVIDENCE_SCHEMA : CROSS_SCHEMA,
      timeoutMs: RESCUE_TIMEOUT_MS,
      checkpointBeforeDeadlineMs: Math.min(CHECKPOINT_BEFORE_MS, 60000)
    };
  });
  rescueResults = await runs.all(rescueLaunches);
  emit("audit-verify " + runId + ": rescue finished");
}

const rescueByTarget = {};
rescueTargets.forEach((target, position) => {
  rescueByTarget[target.laneIndex + "." + target.stageKey] = rescueResults[position];
});

const results = board.map((lane, index) => {
  const finding = selected[index];
  const stageMap = {};
  (lane.stages || []).forEach((stage) => {
    const rescued = rescueByTarget[index + "." + stage.key];
    const rescuedVerdict = rescued && rescued.structuredOutput ? rescued.structuredOutput.verdict : null;
    const rescuedOk = !!(rescued && rescued.ok === true && rescuedVerdict);
    const lost = stageLost(stage);
    stageMap[stage.key] = {
      state: lost ? (rescuedOk ? "rescued" : "lost") : stage.state,
      ok: lost ? rescuedOk : stage.ok,
      run_id: stage.runId,
      artifact: (rescuedOk ? rescued.outputReference : stage.outputReference) || null,
      verdict: stage.verdict || (rescuedVerdict || null),
      lost_reason: lost && !rescuedOk ? (stage.error || "stage ended without a verdict") : null,
      rescued: lost && rescuedOk
    };
  });
  const lostStages = Object.keys(stageMap).filter((key) => stageMap[key].state === "lost");
  return {
    finding_id: finding.id || ("f" + index),
    lane_state: lane.state,
    failed_stage: lane.failedStage || null,
    severity_in: finding.severity || null,
    evidence: stageMap.evidence || null,
    cross: stageMap.cross || null,
    cross_skipped: !stageMap.cross,
    lost_stages: lostStages,
    needs_supervisor: lane.state !== "complete" || lostStages.length > 0
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
  // A stage here produced no verdict even after rescue. The finding has NOT passed its
  // gate: keep it out of `confirmed` and record the gate as failed in the ledger.
  lost_stages: results.reduce((acc, entry) => {
    entry.lost_stages.forEach((stageKey) => acc.push(entry.finding_id + ":" + stageKey));
    return acc;
  }, []),
  results: results,
  next_step: "Read each artifact, set the terminal status, and send conflicts to audit-arbiter."
};
