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

test("parseCliArgs uses headless defaults", () => {
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
      mode: "headless",
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
