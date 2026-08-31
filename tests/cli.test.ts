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
  const parsed = parseCliArgs([]);

  expect(parsed).toMatchObject({
    mode: "headless",
    task: "",
    workspace: process.cwd(),
    port: 3000,
  });
});

test("parseCliArgs accepts --version", () => {
  expect(parseCliArgs(["--version"]).showVersion).toBe(true);
});
