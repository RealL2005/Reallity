import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCliArgs, resolveSessionPaths } from "../src/cli.ts";

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

test("resolveSessionPaths auto-resumes the default session file when present", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reallity-cli-"));
  const defaultFile = path.join(dir, ".reallity", "session.json");
  mkdirSync(path.dirname(defaultFile), { recursive: true });
  writeFileSync(defaultFile, "{}");
  const saved = process.env.REALLITY_SESSION;
  delete process.env.REALLITY_SESSION;
  try {
    const resolved = resolveSessionPaths({ workspace: dir, noSession: false });

    expect(resolved.loadPath).toBe(defaultFile);
    expect(resolved.savePath).toBe(defaultFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.REALLITY_SESSION;
    else process.env.REALLITY_SESSION = saved;
  }
});

test("resolveSessionPaths starts fresh when no session file exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reallity-cli-"));
  const saved = process.env.REALLITY_SESSION;
  delete process.env.REALLITY_SESSION;
  try {
    const resolved = resolveSessionPaths({ workspace: dir, noSession: false });

    expect(resolved.loadPath).toBeUndefined();
    expect(resolved.savePath).toBe(path.join(dir, ".reallity", "session.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.REALLITY_SESSION;
    else process.env.REALLITY_SESSION = saved;
  }
});

test("resolveSessionPaths honors explicit session, save-session, and no-session", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reallity-cli-"));
  const saved = process.env.REALLITY_SESSION;
  delete process.env.REALLITY_SESSION;
  try {
    const explicit = resolveSessionPaths({
      workspace: dir,
      sessionPath: "/tmp/a.json",
      noSession: false,
    });
    expect(explicit.loadPath).toBe("/tmp/a.json");
    expect(explicit.savePath).toBe("/tmp/a.json");

    const saveOnly = resolveSessionPaths({
      workspace: dir,
      saveSessionPath: "/tmp/b.json",
      noSession: false,
    });
    expect(saveOnly.loadPath).toBeUndefined();
    expect(saveOnly.savePath).toBe("/tmp/b.json");

    const none = resolveSessionPaths({ workspace: dir, noSession: true });
    expect(none.loadPath).toBeUndefined();
    expect(none.savePath).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.REALLITY_SESSION;
    else process.env.REALLITY_SESSION = saved;
  }
});
