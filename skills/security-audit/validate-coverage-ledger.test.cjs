"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validateLedger } = require("./validate-coverage-ledger.cjs");

const HERE = __dirname;

function baseLedger(overrides = {}) {
  return {
    run_id: "20260912-auth",
    target: "/repos/acme-api",
    source_ref: "a1b2c3d",
    scope: { in_scope: ["src/"], out_of_scope: ["vendor/"] },
    blocks: [
      {
        block_id: "B01",
        name: "auth middleware",
        paths: ["src/auth", "src/middleware"],
        agent: "audit-authz",
        status: "covered",
        findings: [],
        coverage: { files_read: ["src/auth/session.ts", "src/middleware/auth.ts"], not_covered: [], limits: "framework middleware resolved from registration only" },
      },
      {
        block_id: "B02",
        name: "orders API",
        paths: ["src/api/orders.ts", "src/repo/orders.ts"],
        agent: "audit-authz",
        status: "candidate",
        findings: ["B02-01"],
        coverage: { files_read: ["src/api/orders.ts", "src/repo/orders.ts"], not_covered: [], limits: "framework middleware resolved from registration only" },
      },
    ],
    ...overrides,
  };
}

function baseFinding(overrides = {}) {
  return {
    id: "B02-01",
    block: "B02",
    title: "Order lookup lacks tenant scoping",
    category: "tenant",
    severity: "high",
    confidence: "high",
    status: "confirmed",
    locations: [{ file: "src/api/orders.ts", line: 88 }],
    flow: "orderId -> findById -> row returned",
    impact: "cross-tenant read",
    evidence: [{ file: "src/api/orders.ts", line: 88, quote: "findById(req.params.orderId)" }],
    remediation: "add tenant predicate",
    notes: "",
    ...overrides,
  };
}

function run(ledger, findings) {
  const errors = [];
  validateLedger(ledger, findings === undefined ? null : findings, errors);
  return errors;
}

test("contract-shaped ledger passes without findings", () => {
  assert.deepEqual(run(baseLedger()), []);
});

test("ledger with cross-checked findings passes", () => {
  const findings = [baseFinding({ status: "confirmed" })];
  assert.deepEqual(run(baseLedger(), findings), []);
});

test("run identity is required", () => {
  assert.ok(run(baseLedger({ run_id: "" })).some((e) => e.includes("run_id")));
  assert.ok(run(baseLedger({ target: "" })).some((e) => e.includes("target")));
});

test("blocks must exist", () => {
  assert.ok(run(baseLedger({ blocks: [] })).some((e) => e.includes("no coverage claim")));
});

test("block ids are unique and well-formed", () => {
  const ledger = baseLedger();
  ledger.blocks[1].block_id = "B01";
  assert.ok(run(ledger).some((e) => e.includes('duplicate block_id "B01"')));
  assert.ok(run(baseLedger({ blocks: [{ block_id: "../evil", name: "x", paths: ["src/"], status: "planned", findings: [] }] }))
    .some((e) => e.includes("block_id must match")));
});

test("paths must be relative and inside the repo", () => {
  for (const bad of ["/etc/passwd", "../outside", "C:\\windows\\system32"]) {
    const ledger = baseLedger();
    ledger.blocks[0].paths = [bad];
    assert.ok(run(ledger).some((e) => e.includes("relative repo path")), bad);
  }
});

test("deferred/failed/out_of_scope blocks need a reason", () => {
  for (const status of ["deferred", "failed", "out_of_scope"]) {
    const ledger = baseLedger();
    ledger.blocks[0].status = status;
    delete ledger.blocks[0].reason;
    assert.ok(run(ledger).some((e) => e.includes("requires a non-empty reason")), status);
  }
});

test("covered blocks need a coverage object with read files", () => {
  const ledger = baseLedger();
  ledger.blocks[0].coverage = { files_read: [], not_covered: [], limits: "framework middleware resolved from registration only" };
  assert.ok(run(ledger).some((e) => e.includes("files_read must be a non-empty array")));
  const noCoverage = baseLedger();
  delete noCoverage.blocks[0].coverage;
  assert.ok(run(noCoverage).some((e) => e.includes("requires a coverage object")));
});

test("candidate blocks carry at least one finding", () => {
  const ledger = baseLedger();
  ledger.blocks[1].findings = [];
  assert.ok(run(ledger).some((e) => e.includes('status "candidate" requires at least one finding')));
});

test("every in-scope path has a block behind it", () => {
  const ledger = baseLedger({ scope: { in_scope: ["src/", "internal/"], out_of_scope: [] } });
  assert.ok(run(ledger).some((e) => e.includes('"internal/" has no block covering it')));
});

test("block paths outside the declared scope are caught", () => {
  const ledger = baseLedger();
  ledger.blocks[0].paths = ["scripts/deploy.sh"];
  assert.ok(run(ledger).some((e) => e.includes("outside scope.in_scope")));
});

test("a finding belongs to exactly one block", () => {
  const ledger = baseLedger();
  ledger.blocks[0].findings = ["B02-01"];
  assert.ok(run(ledger).some((e) => e.includes("already owned by")));
});

test("ledger and findings must agree", () => {
  const findings = [baseFinding({ id: "B02-09", status: "confirmed" })];
  const errors = run(baseLedger(), findings);
  assert.ok(errors.some((e) => e.includes('"B02-09" is not listed in block "B02"')), errors.join("\n"));
  assert.ok(errors.some((e) => e.includes('references finding "B02-01" which does not exist')), errors.join("\n"));
});

test("finding referencing a missing block is caught", () => {
  const findings = [baseFinding({ id: "B02-01", block: "B99" })];
  assert.ok(run(baseLedger(), findings).some((e) => e.includes('block "B99" which does not exist')));
});

test("terminal findings need covered work behind them", () => {
  const findings = [baseFinding({ status: "confirmed" })];
  const ledger = baseLedger();
  ledger.blocks[1].status = "planned";
  ledger.blocks[1].coverage = undefined;
  assert.ok(run(ledger, findings).some((e) => e.includes("terminal") && e.includes('"planned"')));
});

test("CLI with findings cross-check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-ledger-test-"));
  try {
    const ledgerPath = path.join(dir, "coverage-ledger.json");
    fs.writeFileSync(ledgerPath, JSON.stringify(baseLedger()));
    const stdout = execFileSync("node", [path.join(HERE, "validate-coverage-ledger.cjs"), ledgerPath], { encoding: "utf8" });
    assert.match(stdout, /OK/);

    const findingsPath = path.join(dir, "findings.json");
    fs.writeFileSync(findingsPath, JSON.stringify([baseFinding({ status: "confirmed" })]));
    const crossStdout = execFileSync(
      "node",
      [path.join(HERE, "validate-coverage-ledger.cjs"), ledgerPath, findingsPath],
      { encoding: "utf8" },
    );
    assert.match(crossStdout, /cross-checked against 1 findings?/);

    fs.writeFileSync(ledgerPath, JSON.stringify(baseLedger({ run_id: "" })));
    let failed = false;
    try {
      execFileSync("node", [path.join(HERE, "validate-coverage-ledger.cjs"), ledgerPath], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      failed = true;
      assert.equal(err.status, 1);
      assert.ok(String(err.stderr).includes("run_id"));
    }
    assert.ok(failed, "invalid ledger must exit 1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
