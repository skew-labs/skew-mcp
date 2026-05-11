#!/usr/bin/env node

import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const server = join(__dirname, "..", "dist", "server.js");

if (existsSync(server)) chmodSync(server, 0o755);
