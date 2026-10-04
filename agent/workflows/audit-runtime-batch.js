// audit-runtime-batch.js — batched dynamic verification against one ready environment.
//
// Usage:
//   subagent({
//     workflowScriptPath: "/Users/zsm/.pi/agent/workflows/audit-runtime-batch.js",
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

const runId = (args && args.runId) || "run";
const environment = (args && args.environment) || {};
const questions = (args && args.questions) || [];
const workspace = (args && args.workspace) || ("./tmp/security-audit/" + runId);
const parallel = (args && args.parallel) === true;

if (!Array.isArray(questions) || questions.length === 0) {
  return { error: "args.questions must be a non-empty array" };
}
if (!environment.base_url && !environment.manifest) {
  return { error: "args.environment needs base_url or manifest; start audit-environment first" };
}

const MAX_QUESTIONS = 20;
const selected = questions.slice(0, MAX_QUESTIONS);
const deferred = questions.slice(MAX_QUESTIONS).map((q) => q.finding_id || "unnamed");

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
    output: workspace + "/evidence/" + safeKey(question, index) + ".runtime.json"
  };
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
    artifact: result ? result.outputReference : null,
    output: result && !structured ? result.output : null,
    error: result && result.ok === false ? "child failed" : null
  };
});

const confirmed = results.filter((entry) => entry.verdict === "confirmed").map((entry) => entry.finding_id);
const blocked = results.filter((entry) => entry.verdict === "blocked" || !entry.ok).map((entry) => entry.finding_id);

emit("audit-runtime-batch " + runId + ": " + confirmed.length + " confirmed, " + blocked.length + " blocked");

return {
  run_id: runId,
  environment: { base_url: environment.base_url || null, compose_project: environment.compose_project || null },
  verified: results.length,
  deferred_questions: deferred,
  confirmed: confirmed,
  blocked: blocked,
  results: results,
  reminder: "Tear the environment down with audit-environment when the batch is done."
};
