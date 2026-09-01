import { test, expect } from "bun:test";
import { parseCliArgs } from "../src/cli.ts";

test("parseCliArgs parses explicit web mode options", () => {
  const parsed = parseCliArgs([
    "--mode",
    "web",
    "--task",
    "add tests",
    "--workspace",
    "/tmp/project",
    "--port",
    "8080",
  ]);

  expect(parsed).toMatchObject({
    mode: "web",
    task: "add tests",
    workspace: "/tmp/project",
    port: 8080,
  });
});

test("parseCliArgs uses tui defaults", () => {
  const keys = [
    "REALLITY_MODEL",
    "REALLITY_BASE_URL",
    "REALLITY_WORKSPACE",
    "REALLITY_PORT",
  ] as const;
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    const parsed = parseCliArgs([]);

    expect(parsed).toMatchObject({
      mode: "tui",
      task: "",
      workspace: process.cwd(),
      port: 3000,
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("parseCliArgs accepts --version", () => {
  expect(parseCliArgs(["--version"]).showVersion).toBe(true);
});

test("parseCliArgs accepts session flags", () => {
  const parsed = parseCliArgs([
    "--session",
    "s.json",
    "--save-session",
    "t.json",
    "--no-session",
  ]);

  expect(parsed.sessionPath).toBe("s.json");
  expect(parsed.saveSessionPath).toBe("t.json");
  expect(parsed.noSession).toBe(true);
});

test("parseCliArgs marks explicit workspace only when overridden", () => {
  expect(parseCliArgs(["--workspace", "/tmp/x"]).workspaceExplicit).toBe(true);
  expect(parseCliArgs([]).workspaceExplicit).toBe(false);
});
