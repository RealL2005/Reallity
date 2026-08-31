import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildReviewPrompt,
  buildVerificationResult,
  runBunTests,
} from "../../src/verify/runner.ts";

test("buildVerificationResult marks a clean exit as passed", () => {
  const result = buildVerificationResult("3 pass\n0 fail", 0);

  expect(result.passed).toBe(true);
  expect(result.diagnostics).toHaveLength(0);
});

test("buildVerificationResult extracts a diagnostic from failing output", () => {
  const output = [
    "(fail) edit_file rejects duplicate match",
    "AssertionError: expected",
    "  expected: \"once\"",
    "  actual: \"twice\"",
    " at tests/tools/guards.test.ts:18:5",
  ].join("\n");

  const result = buildVerificationResult(output, 1);

  expect(result.passed).toBe(false);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0].file).toBe("tests/tools/guards.test.ts");
  expect(result.diagnostics[0].line).toBe(18);
});

test("buildReviewPrompt includes requirement, diff, and files", () => {
  const prompt = buildReviewPrompt({
    requirement: "add AST guardrails",
    diff: "diff --git a/app.ts b/app.ts",
    files: ["src/app.ts"],
  });

  expect(prompt).toContain("add AST guardrails");
  expect(prompt).toContain("diff --git a/app.ts b/app.ts");
  expect(prompt).toContain("src/app.ts");
  expect(prompt).toContain("approved");
});

test("runBunTests executes a passing temporary test", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reallity-verify-"));
  await writeFile(
    path.join(root, "passing.test.ts"),
    'import { test, expect } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n',
  );

  try {
    const result = await runBunTests(root, {
      bunCommand: path.join(process.cwd(), "node_modules/.bin/bun"),
    });

    expect(result.passed).toBe(true);
    expect(result.output).toContain("0 fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runBunTests reports a failing temporary test", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reallity-verify-"));
  await writeFile(
    path.join(root, "failing.test.ts"),
    'import { test, expect } from "bun:test";\ntest("bad", () => { expect(1).toBe(2); });\n',
  );

  try {
    const result = await runBunTests(root, {
      bunCommand: path.join(process.cwd(), "node_modules/.bin/bun"),
    });

    expect(result.passed).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
