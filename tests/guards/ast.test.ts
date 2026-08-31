import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analyzeFile,
  analyzeSource,
  isCodeFile,
} from "../../src/guards/ast.ts";

test("analyzeSource accepts valid TypeScript", () => {
  const result = analyzeSource("const answer: number = 42;\n", "valid.ts");

  expect(result.ok).toBe(true);
  expect(result.diagnostics).toHaveLength(0);
});

test("analyzeSource reports a syntax error with line and message", () => {
  const result = analyzeSource("const broken = ;\n", "broken.ts");

  expect(result.ok).toBe(false);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics[0].message).toContain("Expression expected");
});

test("isCodeFile only treats JS/TS family files as code", () => {
  expect(isCodeFile("app.ts")).toBe(true);
  expect(isCodeFile("app.tsx")).toBe(true);
  expect(isCodeFile("app.js")).toBe(true);
  expect(isCodeFile("README.txt")).toBe(false);
});

test("analyzeFile reads and analyzes a source file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reallity-ast-"));
  const filePath = path.join(root, "app.ts");

  try {
    await writeFile(filePath, "const answer: number = 42;\n");
    expect((await analyzeFile(filePath)).ok).toBe(true);

    await writeFile(filePath, "const answer = ;\n");
    expect((await analyzeFile(filePath)).ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
