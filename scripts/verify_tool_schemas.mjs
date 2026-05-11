#!/usr/bin/env node
// Verifies the published MCP tool schemas stay compatible with AI clients
// that reject JSON Schema composition keywords in tool input schemas.

import { getSkewTools } from "../dist/tools.js";

const COMPOSITION_KEYS = new Set(["oneOf", "anyOf", "allOf"]);
const PROFILES = ["core", "trading", "rfq", "advanced", "governance", "all"];

function walk(value, path, hits) {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (COMPOSITION_KEYS.has(key)) hits.push(childPath);
    walk(child, childPath, hits);
  }
}

const failures = [];

for (const profile of PROFILES) {
  const tools = getSkewTools(profile);
  for (const tool of tools) {
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") {
      failures.push(`${profile}/${tool.name}: missing object inputSchema`);
      continue;
    }
    if (schema.type !== "object") {
      failures.push(`${profile}/${tool.name}: inputSchema.type must be object`);
    }
    const hits = [];
    walk(schema, "inputSchema", hits);
    for (const hit of hits) failures.push(`${profile}/${tool.name}: unsupported ${hit}`);
  }
}

if (failures.length === 0) {
  console.log("verify_tool_schemas: PASS - MCP tool schemas are composition-free");
  process.exit(0);
}

console.error(`verify_tool_schemas: FAIL - ${failures.length} schema issue(s)`);
for (const failure of failures.slice(0, 100)) console.error(`  ${failure}`);
if (failures.length > 100) console.error(`  ... ${failures.length - 100} more`);
process.exit(1);
