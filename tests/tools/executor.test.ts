import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executeTool,
  type ExecutorContext,
  type ToolResult,
} from "../../src/tools/executor.ts";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "reallity-tools-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>) {
  return {
    id: "call_test",
    type: "function" as const,
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function context(overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    workspaceRoot,
    timeoutMs: 1_000,
    ...overrides,
  };
}

async function run(
  name: string,
  args: Record<string, unknown>,
  overrides: Partial<ExecutorContext> = {},
): Promise<ToolResult> {
  return executeTool(call(name, args), context(overrides));
}

test("read_file reads the whole file", async () => {
  await writeFile(path.join(workspaceRoot, "note.txt"), "alpha\nbeta\n");

  const result = await run("read_file", { path: "note.txt" });

  expect(result.success).toBe(true);
  expect(result.output).toContain("alpha");
  expect(result.output).toContain("beta");
});

test("read_file supports start_line and end_line paging", async () => {
  await writeFile(
    path.join(workspaceRoot, "lines.txt"),
    ["1", "2", "3", "4", "5"].join("\n"),
  );

  const result = await run("read_file", {
    path: "lines.txt",
    start_line: 2,
    end_line: 4,
  });

  expect(result.output).toBe("2\n3\n4");
});

test("read_file rejects paths outside the workspace", async () => {
  const result = await run("read_file", { path: "../outside.txt" });

  expect(result.success).toBe(false);
  expect(result.error).toContain("outside workspace");
});

test("edit_file replaces exactly one unique match", async () => {
  const filePath = path.join(workspaceRoot, "app.ts");
  await writeFile(filePath, "const answer = 1;\n");

  const result = await run("edit_file", {
    path: "app.ts",
    old_str: "const answer = 1;",
    new_str: "const answer = 42;",
  });

  expect(result.success).toBe(true);
  expect(await readFile(filePath, "utf8")).toBe("const answer = 42;\n");
});

test("edit_file rejects duplicate matches without writing", async () => {
  const filePath = path.join(workspaceRoot, "dup.txt");
  await writeFile(filePath, "same\nsame\n");

  const result = await run("edit_file", {
    path: "dup.txt",
    old_str: "same",
    new_str: "changed",
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("2 matches");
  expect(await readFile(filePath, "utf8")).toBe("same\nsame\n");
});

test("edit_file rejects TypeScript syntax errors before writing", async () => {
  const filePath = path.join(workspaceRoot, "broken.ts");
  await writeFile(filePath, "const answer = 1;\n");

  const result = await run("edit_file", {
    path: "broken.ts",
    old_str: "const answer = 1;",
    new_str: "const answer = ;",
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("AST guardrail");
  expect(await readFile(filePath, "utf8")).toBe("const answer = 1;\n");
});

test("list_dir lists workspace contents", async () => {
  await writeFile(path.join(workspaceRoot, "a.ts"), "");
  await mkdir(path.join(workspaceRoot, "nested"));

  const result = await run("list_dir", { path: "." });

  expect(result.output).toContain("a.ts");
  expect(result.output).toContain("nested/");
});

test("glob finds matching files", async () => {
  await writeFile(path.join(workspaceRoot, "one.ts"), "");
  await writeFile(path.join(workspaceRoot, "two.ts"), "");
  await writeFile(path.join(workspaceRoot, "three.txt"), "");

  const result = await run("glob", { pattern: "*.ts" });

  expect(result.output).toContain("one.ts");
  expect(result.output).toContain("two.ts");
  expect(result.output).not.toContain("three.txt");
});

test("bash runs a command with non-interactive env", async () => {
  const result = await run("bash", { command: "printf '%s' \"$CI-$PAGER\"" });

  expect(result.success).toBe(true);
  expect(result.output).toContain("true-cat");
});

test("bash rejects high-risk commands", async () => {
  const result = await run("bash", { command: "rm -rf /" });

  expect(result.success).toBe(false);
  expect(result.error).toContain("recursive file deletion");
});

test("bash kills a timed-out process tree", async () => {
  const started = Date.now();
  const result = await run(
    "bash",
    { command: "sleep 5" },
    { timeoutMs: 100 },
  );
  const elapsed = Date.now() - started;

  expect(result.success).toBe(false);
  expect(result.error).toContain("timed out");
  expect(elapsed).toBeLessThan(2_000);
});
