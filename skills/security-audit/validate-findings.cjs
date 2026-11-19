#!/usr/bin/env node
"use strict";
/**
 * Machine validator for audit findings — enforces finding-contract.md.
 *
 * Usage:
 *   node validate-findings.cjs <findings.json>   one JSON file containing an array of findings
 *   node validate-findings.cjs <findings-dir>    every *.json file in the directory must be an array
 *
 * Exit 0 = valid, exit 1 = invalid (all errors printed to stderr), exit 2 = usage error.
 * Zero dependencies: plain Node, no install step. The supervisor (not the agents) runs this.
 */

const fs = require("fs");
const path = require("path");

const CATEGORIES = new Set([
  "authn", "authz", "tenant", "injection", "deserialization", "path", "upload",
  "ssrf", "rce", "crypto", "secrets", "exposure", "logic", "race", "config",
  "dependency", "container", "cicd", "dos", "other",
]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const STATUSES = new Set([
  "candidate", "needs-evidence", "evidence-reviewed", "cross-audited", "runtime-verified",
  "confirmed", "rejected", "uncertain", "duplicate", "approved-for-fix", "fixed", "reverified",
]);
// Pinned enum values for the verification object. Free prose here is what made
// reports unverifiable; these are the only legal values.
const VERIFICATION_ENUMS = {
  evidence_review: new Set(["supported", "insufficient", "refuted"]),
  cross_audit: new Set(["confirmed", "refuted", "skipped"]),
  runtime: new Set(["confirmed", "refuted", "blocked", "not_required", "out_of_scope"]),
  arbitration: new Set(["upheld", "overturned"]),
};
const EVIDENCE_REQUIRED = new Set(["evidence-reviewed", "cross-audited", "runtime-verified", "confirmed", "rejected"]);
const REMEDIATION_REQUIRED = new Set(["approved-for-fix", "fixed", "reverified"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const MAX_QUOTE_CHARS = 600;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_ERRORS = 100;
const VISIBLE = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function hasVisibleContent(value) {
  return typeof value === "string" && VISIBLE.test(value);
}

// ---------------------------------------------------------------------------
// Loading

function readBatch(file) {
  const raw = fs.readFileSync(file);
  if (raw.length > MAX_INPUT_BYTES) {
    throw new Error(`${file} exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  let data;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(data)) {
    // A block artifact from the audit-sweep workflow wraps its findings:
    // { block, coverage, findings: [...], clean_areas, open_questions }
    if (isPlainObject(data) && Array.isArray(data.findings)) {
      const blockId = isNonEmptyString(data.block) ? data.block : null;
      data = data.findings.map((finding) =>
        blockId && isPlainObject(finding) && finding.block === undefined
          ? { ...finding, block: blockId }
          : finding
      );
    } else {
      throw new Error(`${file} must contain a JSON array of findings, or an object with a findings array`);
    }
  }
  return { source: file, findings: data };
}

function loadBatches(target) {
  const stat = fs.statSync(target); // throws on missing path
  if (stat.isDirectory()) {
    const files = fs.readdirSync(target)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (files.length === 0) {
      throw new Error(`no .json files in ${target}`);
    }
    return files.map((name) => readBatch(path.join(target, name)));
  }
  return [readBatch(target)];
}

// ---------------------------------------------------------------------------
// Per-finding validation

function validateFinding(finding, at, errors) {
  const E = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(`${at}: ${message}`);
  };
  if (!isPlainObject(finding)) {
    E("finding must be an object");
    return false;
  }

  for (const key of ["id", "title", "category", "severity", "confidence", "status", "flow", "impact", "locations"]) {
    if (!(key in finding)) E(`missing required field "${key}"`);
  }

  if (!isNonEmptyString(finding.id) || !ID_PATTERN.test(String(finding.id))) {
    E(`id must be a non-empty string matching ${ID_PATTERN}`);
  }
  for (const key of ["title", "flow", "impact"]) {
    if (key in finding && !hasVisibleContent(finding[key])) {
      E(`"${key}" must contain visible content`);
    }
  }
  if (!CATEGORIES.has(finding.category)) {
    E(`category "${finding.category}" is not one of the contract categories`);
  }
  if (!SEVERITIES.has(finding.severity)) {
    E(`severity "${finding.severity}" must be one of critical/high/medium/low/info`);
  }
  if (!CONFIDENCES.has(finding.confidence)) {
    E(`confidence "${finding.confidence}" must be one of high/medium/low`);
  }
  if (!STATUSES.has(finding.status)) {
    E(`status "${finding.status}" is not a contract status`);
  }
  if ("fingerprint" in finding && finding.fingerprint != null) {
    if (!isNonEmptyString(finding.fingerprint) || !FINGERPRINT_PATTERN.test(String(finding.fingerprint))) {
      E(`fingerprint must match ${FINGERPRINT_PATTERN}`);
    }
  }
  if ("block" in finding && finding.block != null && !isNonEmptyString(finding.block)) {
    E("block must be null or a non-empty block id");
  }

  // locations: the where of the finding
  if ("locations" in finding) {
    if (!Array.isArray(finding.locations) || finding.locations.length === 0) {
      E("locations must be a non-empty array");
    } else {
      finding.locations.forEach((location, i) => {
        if (!isPlainObject(location)) {
          E(`locations[${i}] must be an object`);
          return;
        }
        if (!isNonEmptyString(location.file)) E(`locations[${i}].file must be a non-empty string`);
        if (!Number.isInteger(location.line) || location.line < 1) {
          E(`locations[${i}].line must be an integer >= 1`);
        }
        if ("symbol" in location && location.symbol != null && !isNonEmptyString(location.symbol)) {
          E(`locations[${i}].symbol must be a non-empty string when present`);
        }
      });
    }
  }

  // evidence: the proof. Quotes stay short and redacted — never payloads or secrets.
  if ("evidence" in finding) {
    if (!Array.isArray(finding.evidence)) {
      E("evidence must be an array");
    } else {
      finding.evidence.forEach((entry, i) => {
        if (!isPlainObject(entry)) {
          E(`evidence[${i}] must be an object`);
          return;
        }
        if (!isNonEmptyString(entry.file)) E(`evidence[${i}].file must be a non-empty string`);
        if (!Number.isInteger(entry.line) || entry.line < 1) {
          E(`evidence[${i}].line must be an integer >= 1`);
        }
        if (!isNonEmptyString(entry.quote) || !hasVisibleContent(entry.quote)) {
          E(`evidence[${i}].quote must be non-empty visible content`);
        } else if (entry.quote.length > MAX_QUOTE_CHARS) {
          E(`evidence[${i}].quote is ${entry.quote.length} chars (max ${MAX_QUOTE_CHARS}) — quotes stay short and redacted`);
        }
      });
    }
  }
  if (STATUSES.has(finding.status) && EVIDENCE_REQUIRED.has(finding.status) &&
      (!Array.isArray(finding.evidence) || finding.evidence.length === 0)) {
    E(`status "${finding.status}" requires at least one evidence entry`);
  }

  if ("preconditions" in finding && finding.preconditions != null) {
    if (!Array.isArray(finding.preconditions) || finding.preconditions.some((p) => !isNonEmptyString(p))) {
      E("preconditions must be an array of non-empty strings");
    }
  }

  // verification: pinned enums only
  const verification = isPlainObject(finding.verification) ? finding.verification : {};
  if ("verification" in finding && finding.verification != null && !isPlainObject(finding.verification)) {
    E("verification must be an object");
  }
  for (const key of Object.keys(verification)) {
    const allowed = VERIFICATION_ENUMS[key];
    if (!allowed) {
      E(`verification."${key}" is not a known verification key`);
    } else if (verification[key] != null && !allowed.has(verification[key])) {
      E(`verification.${key} "${verification[key]}" must be null or one of: ${[...allowed].join("/")}`);
    }
  }

  // status-conditional contract rules
  if (finding.status === "confirmed") {
    if (verification.evidence_review !== "supported") {
      E('confirmed requires verification.evidence_review === "supported"');
    }
    const crossOk = verification.cross_audit === "confirmed" ||
      (verification.cross_audit === "skipped" && (finding.severity === "low" || finding.severity === "info"));
    if (!crossOk) {
      E('confirmed requires verification.cross_audit === "confirmed", or "skipped" with low/info severity');
    }
    if (finding.needs_runtime === true &&
        !["confirmed", "not_required", "out_of_scope"].includes(verification.runtime)) {
      E('confirmed with needs_runtime=true requires verification.runtime of confirmed/not_required/out_of_scope (an explicit decision, not silence)');
    }
  }
  if (finding.status === "rejected") {
    const hasRefutation = (Array.isArray(finding.evidence) && finding.evidence.length > 0) ||
      isNonEmptyString(finding.notes);
    if (!hasRefutation) {
      E("rejected requires refuting evidence or a notes entry saying why (\"could not reproduce\" alone is uncertain)");
    }
  }
  if (finding.status === "uncertain") {
    const settlesIt = isNonEmptyString(finding.blocked_on) ||
      isNonEmptyString(finding.runtime_question) ||
      isNonEmptyString(finding.notes);
    if (!settlesIt) {
      E("uncertain must state what would settle it: blocked_on, runtime_question, or notes");
    }
  }
  if (finding.status === "duplicate" && !isNonEmptyString(finding.duplicate_of)) {
    E('duplicate requires "duplicate_of" pointing at the surviving finding id');
  }
  if (REMEDIATION_REQUIRED.has(finding.status) && !isNonEmptyString(finding.remediation)) {
    E(`status "${finding.status}" requires a non-empty remediation`);
  }
  if (finding.needs_runtime === true && !isNonEmptyString(finding.runtime_question)) {
    E("needs_runtime=true requires a non-empty runtime_question");
  }
  if ("blocked_on" in finding && finding.blocked_on != null && !isNonEmptyString(finding.blocked_on)) {
    E("blocked_on must be null or a non-empty string stating the exact missing fact");
  }
  if ("duplicate_of" in finding && finding.duplicate_of != null && !isNonEmptyString(finding.duplicate_of)) {
    E("duplicate_of must be null or a non-empty finding id");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cross-finding validation (needs the whole collection)

function crossChecks(items, errors) {
  const E = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };

  const idLocations = new Map();
  for (const { finding, at } of items) {
    if (typeof finding.id !== "string") continue;
    if (idLocations.has(finding.id)) {
      E(`${at}: duplicate id "${finding.id}" (first seen at ${idLocations.get(finding.id)})`);
    } else {
      idLocations.set(finding.id, at);
    }
  }
  for (const { finding, at } of items) {
    if (finding.status === "duplicate" && typeof finding.duplicate_of === "string") {
      if (!idLocations.has(finding.duplicate_of)) {
        E(`${at}: duplicate_of "${finding.duplicate_of}" does not exist in this collection`);
      } else if (finding.duplicate_of === finding.id) {
        E(`${at}: duplicate_of must not reference itself`);
      }
    }
  }
  // fingerprint discipline: two live findings with the same root cause is a merge failure
  const fingerprintOwners = new Map();
  for (const { finding, at } of items) {
    if (finding.status === "duplicate" || typeof finding.fingerprint !== "string" || finding.fingerprint.length === 0) continue;
    if (fingerprintOwners.has(finding.fingerprint)) {
      E(`${at}: fingerprint "${finding.fingerprint}" already claimed at ${fingerprintOwners.get(finding.fingerprint)} — same root cause must be one finding (mark the other duplicate)`);
    } else {
      fingerprintOwners.set(finding.fingerprint, at);
    }
  }
}

function validateFindingsCollection(batches, errors) {
  const items = [];
  for (const batch of batches) {
    batch.findings.forEach((finding, index) => {
      const at = `${batch.source}[${index}]`;
      if (validateFinding(finding, at, errors) && isPlainObject(finding)) {
        items.push({ finding, at });
      }
    });
  }
  crossChecks(items, errors);
}

// ---------------------------------------------------------------------------
// CLI

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node validate-findings.cjs <findings.json | findings-dir>");
    process.exit(2);
  }
  let batches;
  try {
    batches = loadBatches(target);
  } catch (err) {
    console.error(`validate-findings: ${err.message}`);
    process.exit(1);
  }
  const errors = [];
  validateFindingsCollection(batches, errors);
  if (errors.length > 0) {
    for (const error of errors) console.error(`validate-findings: ${error}`);
    console.error(`validate-findings: ${errors.length} error(s)`);
    process.exit(1);
  }
  const total = batches.reduce((count, batch) => count + batch.findings.length, 0);
  console.log(`validate-findings: OK (${total} finding${total === 1 ? "" : "s"} from ${batches.length} source${batches.length === 1 ? "" : "s"})`);
}

if (require.main === module) main();

module.exports = {
  validateFinding,
  validateFindingsCollection,
  loadBatches,
};
