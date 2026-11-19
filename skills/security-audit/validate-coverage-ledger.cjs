#!/usr/bin/env node
"use strict";
/**
 * Machine validator for the run's coverage ledger — enforces coverage-ledger.md.
 *
 * Usage:
 *   node validate-coverage-ledger.cjs <coverage-ledger.json> [findings.json | findings-dir]
 *
 * The optional findings argument enables cross-checks: every ledger-referenced
 * finding id exists, every finding's block exists and lists it, and terminal
 * findings sit on blocks that were actually covered.
 *
 * Exit 0 = valid, exit 1 = invalid, exit 2 = usage error. Zero dependencies.
 */

const fs = require("fs");
const { loadBatches } = require("./validate-findings.cjs");

const BLOCK_STATUSES = new Set(["planned", "in_progress", "covered", "candidate", "deferred", "failed", "out_of_scope"]);
const COVERED_LIKE = new Set(["covered", "candidate"]);
const REASON_REQUIRED = new Set(["deferred", "failed", "out_of_scope"]);
const FINDING_TERMINAL = new Set(["confirmed", "rejected", "uncertain", "duplicate"]);
const BLOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ERRORS = 100;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isRelativePath(value) {
  return isNonEmptyString(value) &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.split(/[\\/]/).includes("..") &&
    !value.includes("\0");
}
function pathWithin(candidate, root) {
  if (candidate === root) return true;
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(normalizedRoot);
}

// ---------------------------------------------------------------------------
// Ledger validation

function validateLedger(ledger, findings, errors) {
  const E = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };

  if (!isPlainObject(ledger)) {
    E("coverage ledger must be an object");
    return;
  }
  if (!isNonEmptyString(ledger.run_id)) E("run_id must be a non-empty string");
  if (!isNonEmptyString(ledger.target)) E("target must be a non-empty string (the audited repo root)");
  if ("source_ref" in ledger && ledger.source_ref != null && !isNonEmptyString(ledger.source_ref)) {
    E("source_ref must be null or a non-empty string (commit/ref)");
  }
  if ("prior_runs" in ledger && ledger.prior_runs != null) {
    if (!Array.isArray(ledger.prior_runs) ||
        ledger.prior_runs.some((run) => !isPlainObject(run) || !isNonEmptyString(run.path))) {
      E("prior_runs must be an array of { path } objects");
    }
  }

  // scope
  let inScope = null;
  if ("scope" in ledger && ledger.scope != null) {
    if (!isPlainObject(ledger.scope)) {
      E("scope must be an object");
    } else {
      for (const key of ["in_scope", "out_of_scope"]) {
        if (key in ledger.scope && ledger.scope[key] != null) {
          if (!Array.isArray(ledger.scope[key]) || ledger.scope[key].some((p) => !isRelativePath(p))) {
            E(`scope.${key} must be an array of relative repo paths (no absolute paths, no "..")`);
          }
        }
      }
      if (Array.isArray(ledger.scope.in_scope)) inScope = ledger.scope.in_scope;
    }
  }

  // blocks
  if (!Array.isArray(ledger.blocks) || ledger.blocks.length === 0) {
    E("blocks must be a non-empty array — an audit with no ledger units has no coverage claim");
    return;
  }
  const blockIds = new Map();
  const findingOwners = new Map();
  const blockPaths = [];
  for (let i = 0; i < ledger.blocks.length; i++) {
    const block = ledger.blocks[i];
    const at = `blocks[${i}]`;
    if (!isPlainObject(block)) {
      E(`${at}: block must be an object`);
      continue;
    }
    if (!isNonEmptyString(block.block_id) || !BLOCK_ID_PATTERN.test(String(block.block_id))) {
      E(`${at}: block_id must match ${BLOCK_ID_PATTERN}`);
    } else if (blockIds.has(block.block_id)) {
      E(`${at}: duplicate block_id "${block.block_id}" (first seen at ${blockIds.get(block.block_id)})`);
    } else {
      blockIds.set(block.block_id, at);
    }
    if (!isNonEmptyString(block.name)) E(`${at}: name must be a non-empty string`);
    if (!Array.isArray(block.paths) || block.paths.length === 0) {
      E(`${at}: paths must be a non-empty array of relative repo paths`);
    } else {
      block.paths.forEach((p, j) => {
        if (!isRelativePath(p)) E(`${at}.paths[${j}]: "${p}" must be a relative repo path (no absolute paths, no "..")`);
      });
      blockPaths.push({ at, paths: block.paths });
    }
    if (!BLOCK_STATUSES.has(block.status)) {
      E(`${at}: status "${block.status}" must be one of: ${[...BLOCK_STATUSES].join("/")}`);
    }
    if ("agent" in block && block.agent != null && !isNonEmptyString(block.agent)) {
      E(`${at}: agent must be null or a non-empty agent name`);
    }
    if (!Array.isArray(block.findings)) {
      E(`${at}: findings must be an array (may be empty)`);
    } else {
      block.findings.forEach((id, j) => {
        if (!isNonEmptyString(id)) {
          E(`${at}.findings[${j}]: finding ids must be non-empty strings`);
          return;
        }
        if (findingOwners.has(id)) {
          E(`${at}.findings[${j}]: finding "${id}" already owned by ${findingOwners.get(id)} — a finding belongs to exactly one block`);
        } else {
          findingOwners.set(id, at);
        }
      });
    }
    // coverage honesty for blocks that claim work
    if (COVERED_LIKE.has(block.status)) {
      if (!isPlainObject(block.coverage)) {
        E(`${at}: status "${block.status}" requires a coverage object`);
      } else {
        if (!Array.isArray(block.coverage.files_read) || block.coverage.files_read.length === 0) {
          E(`${at}: coverage.files_read must be a non-empty array — "covered" without read files is not coverage`);
        } else if (block.coverage.files_read.some((p) => !isNonEmptyString(p))) {
          E(`${at}: coverage.files_read entries must be non-empty strings`);
        }
        if ("not_covered" in block.coverage && block.coverage.not_covered != null &&
            (!Array.isArray(block.coverage.not_covered) ||
             block.coverage.not_covered.some((p) => !isNonEmptyString(p)))) {
          E(`${at}: coverage.not_covered must be an array of non-empty strings`);
        }
        if ("limits" in block.coverage && block.coverage.limits != null &&
            !isNonEmptyString(block.coverage.limits)) {
          E(`${at}: coverage.limits must be null or a non-empty string`);
        }
      }
    }
    if (REASON_REQUIRED.has(block.status) && !isNonEmptyString(block.reason)) {
      E(`${at}: status "${block.status}" requires a non-empty reason`);
    }
    if (block.status === "candidate" && (!Array.isArray(block.findings) || block.findings.length === 0)) {
      E(`${at}: status "candidate" requires at least one finding id`);
    }
  }

  // scope ↔ blocks: every in-scope path has a block; every block path is in scope
  if (inScope !== null && inScope.length > 0 && isNonEmptyString(ledger.run_id)) {
    for (const scopePath of inScope) {
      if (!isRelativePath(scopePath)) continue; // already reported above
      const hasBlock = blockPaths.some((entry) => entry.paths.some((p) => pathWithin(p, scopePath)));
      if (!hasBlock) {
        E(`scope.in_scope entry "${scopePath}" has no block covering it — map it to a block or move it to out_of_scope, never drop it silently`);
      }
    }
    for (const entry of blockPaths) {
      for (const blockPath of entry.paths) {
        if (!isRelativePath(blockPath)) continue;
        if (!inScope.some((scopePath) => pathWithin(blockPath, scopePath))) {
          E(`${entry.at}: block path "${blockPath}" is outside scope.in_scope — either widen the scope or remove the path`);
        }
      }
    }
  }

  // findings cross-checks
  if (findings !== null && findings !== undefined) {
    const findingById = new Map();
    findings.forEach((finding, index) => {
      if (isPlainObject(finding) && isNonEmptyString(finding.id)) findingById.set(finding.id, finding);
    });
    for (const [id, at] of findingOwners) {
      if (!findingById.has(id)) {
        E(`${at}: ledger references finding "${id}" which does not exist in the findings collection`);
      }
    }
    findingById.forEach((finding, id) => {
      if (!isNonEmptyString(finding.block)) return;
      const blockAt = blockIds.get(finding.block);
      if (blockAt === undefined) {
        E(`finding "${id}" references block "${finding.block}" which does not exist in the ledger`);
        return;
      }
      const block = ledger.blocks.find((b) => b.block_id === finding.block);
      if (!Array.isArray(block.findings) || !block.findings.includes(id)) {
        E(`finding "${id}" is not listed in block "${finding.block}".findings — ledger and findings disagree`);
      }
      if (FINDING_TERMINAL.has(finding.status) && block.status !== undefined && !COVERED_LIKE.has(block.status)) {
        E(`finding "${id}" is terminal ("${finding.status}") but its block "${finding.block}" is "${block.status}" — terminal verdicts need covered work behind them`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// CLI

function main() {
  const ledgerPath = process.argv[2];
  const findingsPath = process.argv[3];
  if (!ledgerPath) {
    console.error("usage: node validate-coverage-ledger.cjs <coverage-ledger.json> [findings.json | findings-dir]");
    process.exit(2);
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch (err) {
    console.error(`validate-coverage-ledger: ${ledgerPath} is not readable JSON: ${err.message}`);
    process.exit(1);
  }
  let findings = null;
  if (findingsPath) {
    try {
      findings = loadBatches(findingsPath).flatMap((batch) => batch.findings);
    } catch (err) {
      console.error(`validate-coverage-ledger: cannot load findings: ${err.message}`);
      process.exit(1);
    }
  }
  const errors = [];
  validateLedger(ledger, findings, errors);
  if (errors.length > 0) {
    for (const error of errors) console.error(`validate-coverage-ledger: ${error}`);
    console.error(`validate-coverage-ledger: ${errors.length} error(s)`);
    process.exit(1);
  }
  const covered = ledger.blocks.filter((b) => b && COVERED_LIKE.has(b.status)).length;
  console.log(`validate-coverage-ledger: OK (${ledger.blocks.length} blocks, ${covered} with covered work${findings !== null ? `, cross-checked against ${findings.length} findings` : ""})`);
}

if (require.main === module) main();

module.exports = { validateLedger, BLOCK_STATUSES };
