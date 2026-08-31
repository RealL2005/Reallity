import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitCheckpoint } from "../../src/governance/checkpoint.ts";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "reallity-git-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: root,
  });
  await writeFile(path.join(root, "tracked.txt"), "original\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("GitCheckpoint captures a clean HEAD", async () => {
  const checkpoint = new GitCheckpoint(root);
  const snapshot = await checkpoint.capture();

  expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);
  expect(snapshot.clean).toBe(true);
});

test("GitCheckpoint detects dirty working tree", async () => {
  const checkpoint = new GitCheckpoint(root);
  await writeFile(path.join(root, "tracked.txt"), "changed\n");

  expect(await checkpoint.isClean()).toBe(false);
});

test("GitCheckpoint rolls tracked changes back to the captured state", async () => {
  const checkpoint = new GitCheckpoint(root);
  const snapshot = await checkpoint.capture();
  await writeFile(path.join(root, "tracked.txt"), "changed\n");

  await checkpoint.rollback();

  expect(await checkpoint.isClean()).toBe(true);
  expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe(
    "original\n",
  );
  expect(await checkpoint.capture()).toMatchObject({ head: snapshot.head });
});

test("GitCheckpoint returns a diff for tracked changes", async () => {
  const checkpoint = new GitCheckpoint(root);
  await writeFile(path.join(root, "tracked.txt"), "changed\n");

  const diff = await checkpoint.diff();

  expect(diff).toContain("--- a/tracked.txt");
  expect(diff).toContain("+changed");
});

test("GitCheckpoint commits all changes", async () => {
  const checkpoint = new GitCheckpoint(root);
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  await writeFile(path.join(root, "new.txt"), "new\n");

  await checkpoint.commitAll("feat: test commit");

  expect(await checkpoint.isClean()).toBe(true);
  const log = await execFileAsync("git", ["log", "--oneline", "-1"], {
    cwd: root,
  });
  expect(log.stdout).toContain("feat: test commit");
});
