#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const cliPath = path.join(projectRoot, "src", "cli.ts");
const localBun = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "bun.exe" : "bun",
);
const bun = existsSync(localBun) ? localBun : "bun";
const args = ["run", cliPath, ...process.argv.slice(2)];

const child = spawn(bun, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`Failed to start Reallity: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
