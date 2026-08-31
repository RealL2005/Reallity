import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectVerificationCommand } from "../../src/verify/runner.ts";

test("detectVerificationCommand prefers the test script", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reallity-detect-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
  );

  try {
    expect(await detectVerificationCommand(root)).toEqual(["bun", "run", "test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectVerificationCommand falls back to lint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reallity-detect-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { lint: "eslint ." } }),
  );

  try {
    expect(await detectVerificationCommand(root)).toEqual(["bun", "run", "lint"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectVerificationCommand returns empty when no verification script exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reallity-detect-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x" }));

  try {
    expect(await detectVerificationCommand(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
