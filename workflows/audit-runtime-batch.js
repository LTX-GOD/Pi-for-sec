// audit-runtime-batch.js — batched dynamic verification against one ready environment.
//
// Usage:
//   subagent({
//     workflow: "/Users/zsm/.pi/agent/workflows/audit-runtime-batch.js",
//     args: {
//       runId: "20260912-auth",
//       environment: { base_url: "http://127.0.0.1:18080", compose_project: "audit_20260912-auth",
//                      manifest: "./tmp/security-audit/20260912-auth/env/environment.json" },
//       questions: [ { finding_id: "B03-02", runtime_question: "...", repro: "..." } ],
//       parallel: false
//     },
//     async: true
//   })
//
// Serial by default: probes against one shared environment can interfere with each other.
// Set parallel: true only when every question uses isolated data.
//
// Budget: every probe gets a hard deadline and a pre-deadline checkpoint steer. A probe
// that dies without a verdict is retried once as a rescue child that must return
// `inconclusive` (or `blocked`) rather than guess. An unresolved probe is reported as
// blocked — never as "not reproducible", which would close the finding on no evidence.

const runId = (args && args.runId) || "run";
const environment = (args && args.environment) || {};
const questions = (args && args.questions) || [];
const workspace = (args && args.workspace) || ("./tmp/security-audit/" + runId);
const parallel = (args && args.parallel) === true;

const PROBE_TIMEOUT_MS = (args && args.timeoutMs) || 2400000;
const CHECKPOINT_BEFORE_MS = (args && args.checkpointBeforeDeadlineMs) || 300000;
const RESCUE_TIMEOUT_MS = (args && args.rescueTimeoutMs) || 300000;
const rescue = (args && args.rescue) !== false;

if (!Array.isArray(questions) || questions.length === 0) {
  return { error: "args.questions must be a non-empty array" };
}
if (!environment.base_url && !environment.manifest) {
  return { error: "args.environment needs base_url or manifest; start audit-environment first" };
}

const MAX_QUESTIONS = 20;
const selected = questions.slice(0, MAX_QUESTIONS);
const deferred = questions.slice(MAX_QUESTIONS).map((q) => q.finding_id || "unnamed");

// Matches the verdict contract in agents/audit/audit-runtime.md.
// Without outputSchema no structuredOutput is produced at all, so the
// confirmed/blocked aggregation below would always be empty.
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string" },
    verdict: { type: "string", enum: ["confirmed", "not-reproducible", "blocked", "inconclusive"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    environment: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        base_url: { type: "string" },
        verified_live: { type: "boolean" }
      }
    },
    baseline: {
      type: "object",
      properties: { description: { type: "string" }, result: { type: "string" } }
    },
    attempts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          intent: { type: "string" },
          identity: { type: "string" },
          command: { type: "string" },
          request: { type: "string" },
          response_status: { type: "number" },
          response_excerpt: { type: "string" },
          observation: { type: "string" }
        }
      }
    },
    negative_control: {
      type: "object",
      properties: { description: { type: "string" }, result: { type: "string" } }
    },
    proof: { type: "string" },
    impact_observed: { type: "string" },
    side_effects: { type: "array", items: { type: "string" } },
    cleanup: { type: "string" },
    limits: { type: "string" },
    recommended_status: { type: "string", enum: ["confirmed", "rejected", "uncertain"] }
  },
  required: ["finding_id", "verdict", "confidence", "recommended_status"]
};

function safeKey(question, index) {
  const raw = String(question.finding_id || ("q" + index));
  return raw.replace(/[^A-Za-z0-9._-]/g, "-");
}

function verifyTask(question) {
  const lines = [
    "Verify one finding against the running audit environment. Answer only this question.",
    "",
    "Finding id: " + (question.finding_id || ""),
    "Runtime question: " + (question.runtime_question || ""),
    ""
  ];
  if (question.repro) {
    lines.push("Suggested reproduction from the static audit:");
    lines.push(question.repro);
    lines.push("");
  }
  if (question.context) {
    lines.push("Context: " + question.context);
    lines.push("");
  }
  lines.push("Environment:");
  lines.push("  base_url: " + (environment.base_url || "see manifest"));
  lines.push("  compose_project: " + (environment.compose_project || ""));
  lines.push("  manifest: " + (environment.manifest || workspace + "/env/environment.json"));
  lines.push("");
  lines.push("Rules:");
  lines.push("- Confirm the environment is live before testing; report blocked if it is not.");
  lines.push("- Do not start, stop or reconfigure the environment.");
  lines.push("- Do not modify source code or send traffic outside this environment.");
  lines.push("- Establish a baseline, run the minimal decisive probe, then a negative control.");
  lines.push("- Use inert marker values, prefix created data with audit-" + runId + "-.");
  lines.push("- Redact credentials in every recorded request and response.");
  lines.push("- Return the verdict JSON object.");
  return lines.join("\n");
}

function launchFor(question, index) {
  return {
    key: "verify-" + safeKey(question, index),
    label: "Runtime verify " + (question.finding_id || index),
    agent: "audit-runtime",
    task: verifyTask(question),
    context: "fresh",
    output: workspace + "/evidence/" + safeKey(question, index) + ".runtime.json",
    outputSchema: VERDICT_SCHEMA,
    timeoutMs: PROBE_TIMEOUT_MS,
    checkpointBeforeDeadlineMs: CHECKPOINT_BEFORE_MS
  };
}

// A killed probe leaves no verdict. The rescue child is told, explicitly, that the correct
// answer is `inconclusive` with the reason — not a guess at confirmed or not-reproducible.
function rescueTask(question, previous) {
  const error = previous && previous.error ? String(previous.error).slice(0, 2000) : "(no error recorded)";
  return [
    "A previous runtime probe for this question was killed before it returned a verdict.",
    "Return a schema-valid verdict using what is already known. Do not start a new investigation.",
    "",
    "Previous failure: " + error,
    "",
    "Finding id: " + (question.finding_id || ""),
    "Runtime question: " + (question.runtime_question || ""),
    question.repro ? "Suggested reproduction: " + question.repro : "",
    "",
    "Environment:",
    "  base_url: " + (environment.base_url || "see manifest"),
    "  compose_project: " + (environment.compose_project || ""),
    "  manifest: " + (environment.manifest || workspace + "/env/environment.json"),
    "",
    "Rules:",
    "- If the environment does not answer on one cheap health check, verdict \"blocked\".",
    "- You may run at most the single decisive probe and its control. No exploration.",
    "- If you cannot reach a decisive result, verdict \"inconclusive\" and state in the notes",
    "  exactly which observation would settle it. That is the expected outcome here.",
    "- Never answer \"confirmed\" or \"not-reproducible\" from reasoning alone.",
    "- Do not start, stop or reconfigure the environment; do not modify source.",
    "- Redact credentials in every recorded request and response.",
    "- Return the verdict JSON object."
  ].filter(Boolean).join("\n");
}

emit("audit-runtime-batch " + runId + ": " + selected.length + " questions, mode " + (parallel ? "parallel" : "serial"));

let raw = [];
if (parallel) {
  raw = await runs.all(selected.map(launchFor));
} else {
  for (let index = 0; index < selected.length; index++) {
    const launch = launchFor(selected[index], index);
    const settled = await runs.run(launch.key, launch);
    raw.push(settled);
    emit("verified " + (index + 1) + "/" + selected.length + ": " + (selected[index].finding_id || index));
  }
}

const results = raw.map((result, index) => {
  const question = selected[index];
  const structured = result && result.structuredOutput ? result.structuredOutput : null;
  return {
    finding_id: question.finding_id || ("q" + index),
    ok: !!(result && result.ok),
    verdict: structured && structured.verdict ? structured.verdict : null,
    recommended_status: structured && structured.recommended_status ? structured.recommended_status : null,
    confidence: structured && structured.confidence ? structured.confidence : null,
    verified_live: structured && structured.environment && typeof structured.environment.verified_live === "boolean" ? structured.environment.verified_live : null,
    side_effects: structured && Array.isArray(structured.side_effects) ? structured.side_effects : [],
    artifact: result ? result.outputReference : null,
    output: result && !structured ? result.output : null,
    error: result && result.ok === false ? "child failed" : null
  };
});

// A probe with no verdict proved nothing. Rescue it once before declaring it blocked.
const unresolved = results.map((entry, index) => ({ entry: entry, index: index })).filter((item) => !item.entry.verdict);

let rescuedProbes = [];
if (rescue && unresolved.length > 0) {
  emit("audit-runtime-batch " + runId + ": " + unresolved.length + " probe(s) need a deadline rescue");
  const rescueLaunches = unresolved.map((item) => {
    const question = selected[item.index];
    return {
      key: "verify-" + safeKey(question, item.index) + "-rescue",
      label: "Rescue verify " + (question.finding_id || item.index),
      agent: "audit-runtime",
      task: rescueTask(question, raw[item.index]),
      context: "fresh",
      output: workspace + "/evidence/" + safeKey(question, item.index) + ".runtime.rescue.json",
      outputSchema: VERDICT_SCHEMA,
      timeoutMs: RESCUE_TIMEOUT_MS,
      checkpointBeforeDeadlineMs: Math.min(CHECKPOINT_BEFORE_MS, 60000)
    };
  });
  if (parallel) {
    rescuedProbes = await runs.all(rescueLaunches);
  } else {
    for (let r = 0; r < rescueLaunches.length; r++) {
      const settled = await runs.run(rescueLaunches[r].key, rescueLaunches[r]);
      rescuedProbes.push(settled);
    }
  }
  emit("audit-runtime-batch " + runId + ": rescue finished");
}

unresolved.forEach((item, position) => {
  const rescued = rescuedProbes[position];
  const structured = rescued && rescued.structuredOutput ? rescued.structuredOutput : null;
  if (!structured || !structured.verdict) return;
  results[item.index].verdict = structured.verdict;
  results[item.index].recommended_status = structured.recommended_status || null;
  results[item.index].confidence = structured.confidence || null;
  results[item.index].verified_live = structured.environment && typeof structured.environment.verified_live === "boolean" ? structured.environment.verified_live : null;
  results[item.index].side_effects = Array.isArray(structured.side_effects) ? structured.side_effects : [];
  results[item.index].artifact = rescued.outputReference || results[item.index].artifact;
  results[item.index].output = null;
  results[item.index].rescued = true;
});

const confirmed = results.filter((entry) => entry.verdict === "confirmed").map((entry) => entry.finding_id);
const blocked = results.filter((entry) => entry.verdict === "blocked" || !entry.ok).map((entry) => entry.finding_id);
// No verdict even after rescue: the question is open. The supervisor must not read this as
// "not reproducible" — the finding keeps needs_runtime and stays out of confirmed.
const no_verdict = results.filter((entry) => !entry.verdict).map((entry) => entry.finding_id);

emit("audit-runtime-batch " + runId + ": " + confirmed.length + " confirmed, " + blocked.length + " blocked, " + no_verdict.length + " without verdict");

return {
  run_id: runId,
  environment: { base_url: environment.base_url || null, compose_project: environment.compose_project || null },
  verified: results.length,
  deferred_questions: deferred,
  confirmed: confirmed,
  blocked: blocked,
  no_verdict: no_verdict,
  results: results,
  reminder: "Tear the environment down with audit-environment when the batch is done."
};
