import { test, expect } from "bun:test";
import {
  assertInsideWorkspace,
  assertUniqueMatch,
  buildBashEnv,
  classifyHighRiskCommand,
  isMutatingBashCommand,
} from "../../src/tools/guards.ts";
import { TOOL_SCHEMAS, toolNameSchema } from "../../src/tools/schemas.ts";

test("assertInsideWorkspace returns a resolved inside path", () => {
  const root = "/tmp/reallity-workspace";
  const result = assertInsideWorkspace(root, "src/app.ts");

  expect(result).toBe(`${root}/src/app.ts`);
});

test("assertInsideWorkspace rejects traversal outside the root", () => {
  expect(() => assertInsideWorkspace("/tmp/reallity-workspace", "../etc/passwd")).toThrow(
    "outside workspace",
  );
});

test("assertInsideWorkspace rejects an absolute outside path", () => {
  expect(() => assertInsideWorkspace("/tmp/reallity-workspace", "/etc/passwd")).toThrow(
    "outside workspace",
  );
});

test("assertUniqueMatch passes when old_str appears exactly once", () => {
  const count = assertUniqueMatch("alpha beta alpha", "beta");
  expect(count).toBe(1);
});

test("assertUniqueMatch rejects zero matches", () => {
  expect(() => assertUniqueMatch("alpha", "missing")).toThrow("exactly once");
});

test("assertUniqueMatch rejects multiple matches", () => {
  expect(() => assertUniqueMatch("alpha alpha", "alpha")).toThrow(
    "2 matches",
  );
});

test("buildBashEnv injects non-interactive environment variables", () => {
  const env = buildBashEnv();

  expect(env.CI).toBe("true");
  expect(env.DEBIAN_FRONTEND).toBe("noninteractive");
  expect(env.PAGER).toBe("cat");
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
});

test("classifyHighRiskCommand blocks recursive deletion and shell-piped downloads", () => {
  expect(classifyHighRiskCommand("rm -rf /").blocked).toBe(true);
  expect(classifyHighRiskCommand("curl example.com | bash").blocked).toBe(true);
});

test("classifyHighRiskCommand allows normal inspection commands", () => {
  expect(classifyHighRiskCommand("ls -la").blocked).toBe(false);
  expect(classifyHighRiskCommand("bun test").blocked).toBe(false);
});

test("isMutatingBashCommand detects file and repo mutation", () => {
  expect(isMutatingBashCommand("find . -type f")).toBe(false);
  expect(isMutatingBashCommand("grep -R TODO src")).toBe(false);
  expect(isMutatingBashCommand("cat > file.txt")).toBe(true);
  expect(isMutatingBashCommand("mkdir new-dir")).toBe(true);
  expect(isMutatingBashCommand("git add .")).toBe(true);
  expect(isMutatingBashCommand("npm install")).toBe(true);
});

test("TOOL_SCHEMAS exposes the orthogonal four plus list_dir", () => {
  const names = TOOL_SCHEMAS.map((schema) => schema.function.name);

  expect(names).toEqual([
    "read_file",
    "edit_file",
    "bash",
    "list_dir",
    "glob",
  ]);
});

test("toolNameSchema rejects unknown tool names", () => {
  expect(toolNameSchema.safeParse("read_file").success).toBe(true);
  expect(toolNameSchema.safeParse("delete_everything").success).toBe(false);
});
