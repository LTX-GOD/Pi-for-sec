"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validateFindingsCollection, validateFinding } = require("./validate-findings.cjs");

const HERE = __dirname;

function baseFinding(overrides = {}) {
  return {
    id: "B01-01",
    block: "B01",
    fingerprint: "src/repo/orders.ts/findById-no-tenant-predicate",
    title: "Order lookup accepts any order id without tenant scoping",
    category: "tenant",
    severity: "high",
    confidence: "high",
    status: "candidate",
    locations: [{ file: "src/api/orders.ts", line: 88, symbol: "getOrder" }],
    flow: "req.params.orderId -> getOrder() -> ordersRepo.findById(id) -> row returned",
    impact: "Any authenticated user can read any other tenant's order",
    preconditions: ["authenticated session"],
    evidence: [
      { file: "src/api/orders.ts", line: 88, quote: "const order = await ordersRepo.findById(req.params.orderId)" },
    ],
    repro: "Authenticate as tenant A, GET /api/orders/<id-owned-by-tenant-B>",
    existing_mitigations: "authMiddleware applies to /api/*; no tenant predicate on this path",
    needs_runtime: true,
    runtime_question: "Does a tenant-A session receive a 200 with tenant-B order data?",
    remediation: "Scope the repository query by the session tenant id",
    notes: "",
    verification: null,
    ...overrides,
  };
}

function run(input) {
  const errors = [];
  const findings = Array.isArray(input) ? input : [input];
  validateFindingsCollection([{ source: "test.json", findings }], errors);
  return errors;
}

test("contract-shaped findings pass", () => {
  assert.deepEqual(run(baseFinding()), []);
});

test("the finding-contract.md example passes", () => {
  const example = {
    id: "B03-02",
    block: "B03",
    title: "Order lookup accepts any order id without tenant scoping",
    category: "tenant",
    severity: "high",
    confidence: "high",
    status: "confirmed",
    locations: [
      { file: "src/api/orders.ts", line: 88, symbol: "getOrder" },
      { file: "src/repo/orders.ts", line: 41, symbol: "findById" },
    ],
    flow: "req.params.orderId -> getOrder() -> ordersRepo.findById(id) (no tenant predicate) -> row returned",
    impact: "Any authenticated user can read any other tenant's order, including billing address and totals",
    preconditions: ["authenticated session", "knows or can enumerate an order id"],
    evidence: [
      { file: "src/api/orders.ts", line: 88, quote: "const order = await ordersRepo.findById(req.params.orderId)" },
      { file: "src/repo/orders.ts", line: 41, quote: "return db.select().from(orders).where(eq(orders.id, id))" },
    ],
    repro: "Authenticate as tenant A, GET /api/orders/<id-owned-by-tenant-B>",
    existing_mitigations: "authMiddleware applies to /api/*; no tenant predicate anywhere on this path",
    needs_runtime: true,
    runtime_question: "Does a tenant-A session receive a 200 with tenant-B order data?",
    verification: {
      evidence_review: "supported",
      cross_audit: "confirmed",
      runtime: "confirmed",
      arbitration: null,
    },
    remediation: "Scope the repository query by the session tenant id; add a tenant predicate at the repo layer, not the handler",
    notes: "",
  };
  assert.deepEqual(run(example), []);
});

test("missing required field is reported", () => {
  const broken = baseFinding();
  delete broken.impact;
  const errors = run(broken);
  assert.ok(errors.some((e) => e.includes('missing required field "impact"')), errors.join("\n"));
});

test("bad enum values are reported", () => {
  assert.ok(run(baseFinding({ category: "sql-injection" })).some((e) => e.includes("category")));
  assert.ok(run(baseFinding({ severity: "catastrophic" })).some((e) => e.includes("severity")));
  assert.ok(run(baseFinding({ confidence: "maybe" })).some((e) => e.includes("confidence")));
  assert.ok(run(baseFinding({ status: "probably-fine" })).some((e) => e.includes("status")));
});

test("locations must be non-empty with positive integer lines", () => {
  assert.ok(run(baseFinding({ locations: [] })).some((e) => e.includes("locations must be a non-empty array")));
  const badLine = baseFinding();
  badLine.locations = [{ file: "src/x.ts", line: 0 }];
  assert.ok(run(badLine).some((e) => e.includes("line must be an integer >= 1")));
});

test("evidence quotes have a length cap for redaction", () => {
  const long = baseFinding();
  long.evidence = [{ file: "src/x.ts", line: 1, quote: "a".repeat(601) }];
  assert.ok(run(long).some((e) => e.includes("max 600")));
});

test("confirmed requires supported evidence review", () => {
  const finding = baseFinding({ status: "confirmed", verification: {} });
  assert.ok(run(finding).some((e) => e.includes('evidence_review === "supported"')));
});

test("confirmed requires cross audit confirmation, or an explicit low/info skip", () => {
  const finding = baseFinding({
    status: "confirmed",
    verification: { evidence_review: "supported", cross_audit: null },
  });
  assert.ok(run(finding).some((e) => e.includes("cross_audit")));
  const skippedAtHigh = baseFinding({
    status: "confirmed",
    severity: "high",
    verification: { evidence_review: "supported", cross_audit: "skipped" },
  });
  assert.ok(run(skippedAtHigh).some((e) => e.includes("cross_audit")), "skip is only legal at low/info");
  const skippedAtLow = baseFinding({
    status: "confirmed",
    severity: "low",
    needs_runtime: false,
    runtime_question: null,
    verification: { evidence_review: "supported", cross_audit: "skipped" },
  });
  assert.deepEqual(run(skippedAtLow), []);
});

test("confirmed with needs_runtime requires an explicit runtime decision", () => {
  const finding = baseFinding({
    status: "confirmed",
    verification: { evidence_review: "supported", cross_audit: "confirmed" },
  });
  assert.ok(run(finding).some((e) => e.includes("needs_runtime=true requires verification.runtime")));
  const decided = baseFinding({
    status: "confirmed",
    verification: { evidence_review: "supported", cross_audit: "confirmed", runtime: "out_of_scope" },
  });
  assert.deepEqual(run(decided), []);
});

test("rejected requires refutation", () => {
  const finding = baseFinding({ status: "rejected", evidence: [], notes: "" });
  assert.ok(run(finding).some((e) => e.includes("rejected requires refuting evidence")));
});

test("uncertain must state what would settle it", () => {
  const finding = baseFinding({
    status: "uncertain",
    needs_runtime: false,
    runtime_question: null,
    notes: "",
    blocked_on: null,
  });
  assert.ok(run(finding).some((e) => e.includes("what would settle it")));
  const settled = baseFinding({
    status: "uncertain",
    needs_runtime: false,
    runtime_question: null,
    blocked_on: "deployment nginx.conf not in repo: does it strip the X-Override header?",
  });
  assert.deepEqual(run(settled), []);
});

test("duplicate requires a live duplicate_of target", () => {
  const orphan = baseFinding({ status: "duplicate", duplicate_of: "B09-99" });
  assert.ok(run(orphan).some((e) => e.includes("does not exist")));
  const selfRef = baseFinding({ status: "duplicate", duplicate_of: "B01-01" });
  assert.ok(run(selfRef).some((e) => e.includes("must not reference itself")));
  const proper = [baseFinding(), baseFinding({ id: "B01-02", status: "duplicate", duplicate_of: "B01-01", fingerprint: null })];
  assert.deepEqual(run(proper), []);
});

test("two live findings cannot claim the same fingerprint", () => {
  const collision = [
    baseFinding({ id: "B01-01" }),
    baseFinding({ id: "B02-01", block: "B02", title: "Admin export reuses the unscoped findById" }),
  ];
  assert.ok(run(collision).some((e) => e.includes("fingerprint") && e.includes("already claimed")));
});

test("duplicate ids across a collection are caught", () => {
  const collision = [baseFinding(), baseFinding({ block: "B02" })];
  assert.ok(run(collision).some((e) => e.includes('duplicate id "B01-01"')));
});

test("verification values are pinned enums", () => {
  const finding = baseFinding({
    verification: { evidence_review: "looks-good-to-me", runtime: "yes" },
  });
  const errors = run(finding);
  assert.ok(errors.some((e) => e.includes("verification.evidence_review")));
  assert.ok(errors.some((e) => e.includes("verification.runtime")));
});

test("fix states require a remediation", () => {
  for (const status of ["approved-for-fix", "fixed", "reverified"]) {
    const finding = baseFinding({ status, remediation: "" });
    assert.ok(run(finding).some((e) => e.includes("non-empty remediation")), status);
  }
});

test("needs_runtime requires a runtime_question", () => {
  const finding = baseFinding({ runtime_question: "" });
  assert.ok(run(finding).some((e) => e.includes("non-empty runtime_question")));
});

test("validateFinding is exported for direct use", () => {
  const errors = [];
  validateFinding(baseFinding(), "x[0]", errors);
  assert.deepEqual(errors, []);
});

test("CLI: file, directory, and exit codes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-findings-test-"));
  try {
    const good = path.join(dir, "B01.json");
    fs.writeFileSync(good, JSON.stringify([baseFinding()]));
    const stdout = execFileSync("node", [path.join(HERE, "validate-findings.cjs"), good], { encoding: "utf8" });
    assert.match(stdout, /OK/);

    const bad = path.join(dir, "B02.json");
    fs.writeFileSync(bad, JSON.stringify([baseFinding({ severity: "meh" })]));
    let failed = false;
    try {
      execFileSync("node", [path.join(HERE, "validate-findings.cjs"), bad], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      failed = true;
      assert.equal(err.status, 1);
      assert.ok(String(err.stderr).includes("severity"));
    }
    assert.ok(failed, "invalid findings must exit 1");

    const findingsDir = path.join(dir, "findings");
    fs.mkdirSync(findingsDir);
    fs.writeFileSync(path.join(findingsDir, "B01.json"), JSON.stringify([baseFinding()]));
    const dirStdout = execFileSync("node", [path.join(HERE, "validate-findings.cjs"), findingsDir], { encoding: "utf8" });
    assert.match(dirStdout, /1 finding/);

    const emptyDir = path.join(dir, "empty");
    fs.mkdirSync(emptyDir);
    let missing = false;
    try {
      execFileSync("node", [path.join(HERE, "validate-findings.cjs"), emptyDir], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      missing = true;
      assert.equal(err.status, 1);
    }
    assert.ok(missing, "empty findings dir must exit 1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
