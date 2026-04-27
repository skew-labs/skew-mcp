#!/usr/bin/env node
// IP-leak verification — runs against the bundled MCP package output.
// Greps the dist/ JavaScript and the source files for any term in the
// forbidden registry. Fails with non-zero exit if any term hits.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// Inline list — keep in sync with src/__forbidden_terms.ts. We do not
// import the TS file here to keep the verifier dependency-free; both files
// share the same source-of-truth content.
const FORBIDDEN = [
  "POT-GPD",
  "Hamilton",
  "Yang-Zhang",
  "Yang–Zhang",
  "RiskMetrics",
  "EWMA",
  "GARCH",
  "Heston",
  "AR(1)",
  "VRP",
  "vrp_rel",
  "VaR_99",
  "ES_99",
  "es_999",
  "var_99",
  "xi_micro",
  "beta_micro",
  "kappa",
  "theta_d",
  "theta_long_term",
  "sigma_inf",
  "sigma_t_micro",
  "p_max_micro",
  "regime_indicator_micro",
  "returns_buf",
  "iv_history",
  "iv_idx",
  "sigma_inf_window",
  "synth_iv",
  "Phase 1",
  "phase_1",
  "master paper",
  "spec §",
  "AGENT-PROTOCOL",
  "Iron Law",
  "Article 7",
  "DISPROVEN",
  "Hansen-Lunde",
  "Hansen–Lunde",
];

// Dirs we audit. dist/ is the npm-published artifact; src/ is the source
// that produces it; tools/server descriptions are user-facing.
const AUDIT_DIRS = ["dist", "src", "README.md", "package.json"];

// Files we EXCLUDE from auditing — the registry itself enumerates the
// terms by definition, so it would self-fail.
const EXCLUDE = [
  join("src", "__forbidden_terms.ts"),
  join("scripts", "verify_no_leak.mjs"),
];

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".map"]);

function walk(p) {
  const out = [];
  const stat = statSync(p);
  if (stat.isFile()) {
    out.push(p);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const name of readdirSync(p)) {
    out.push(...walk(join(p, name)));
  }
  return out;
}

function isExcluded(rel) {
  return EXCLUDE.some((e) => rel.endsWith(e) || rel === e);
}

let totalHits = 0;
const hits = [];

for (const dir of AUDIT_DIRS) {
  const abs = join(ROOT, dir);
  let files;
  try {
    files = walk(abs);
  } catch {
    continue; // dir doesn't exist (e.g. dist/ before build)
  }
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
    if (isExcluded(rel)) continue;
    if (!TEXT_EXT.has(extname(file))) continue;
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const term of FORBIDDEN) {
      const idx = content.indexOf(term);
      if (idx !== -1) {
        const snippet = content
          .slice(Math.max(0, idx - 40), Math.min(content.length, idx + term.length + 40))
          .replace(/\n/g, " ");
        hits.push({ file: rel, term, snippet });
        totalHits += 1;
      }
    }
  }
}

if (totalHits === 0) {
  console.log("✓ verify_no_leak: PASS — 0 forbidden terms found");
  process.exit(0);
} else {
  console.error(`✗ verify_no_leak: FAIL — ${totalHits} forbidden term hits`);
  for (const hit of hits.slice(0, 50)) {
    console.error(`  ${hit.file} → "${hit.term}"`);
    console.error(`    ...${hit.snippet}...`);
  }
  if (hits.length > 50) console.error(`  ... ${hits.length - 50} more`);
  process.exit(1);
}
