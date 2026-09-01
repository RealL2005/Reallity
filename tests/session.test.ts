import { test, expect, beforeEach } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Session } from "../src/session.ts";
import { EventBus } from "../src/observer/events.ts";
import type { ChatMessage, LLMResponse } from "../src/llm/types.ts";

const execFileAsync = promisify(execFile);

function usage() {
  return {
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 1,
  };
}

class FakeClient {
  readonly seen: ChatMessage[][] = [];
  private calls = 0;
  constructor(private readonly answers: string[]) {}

  async streamCompletion(messages: ChatMessage[]): Promise<LLMResponse> {
    this.seen.push(messages);
    const content = this.answers[this.calls] ?? "done";
    this.calls += 1;
    return {
      content,
      reasoningContent: "",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    };
  }
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "reallity-session-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agent@example.com"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "Agent"], { cwd: root });
  await writeFile(path.join(root, "file.txt"), "hello\n");
  await writeFile(path.join(root, ".gitignore"), "trace.html\n.reallity/\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
});

test("ask runs a task and records session metadata and events", async () => {
  const bus = new EventBus();
  const session = new Session({
    workspaceRoot: root,
    client: new FakeClient([]),
    eventBus: bus,
  });
  const result = await session.ask("hello");

  expect(result.success).toBe(true);
  expect(session.tasks).toHaveLength(1);
  expect(session.tasks[0]).toMatchObject({
    index: 0,
    task: "hello",
    success: true,
  });
  const types = bus.history.map((event) => event.type);
  expect(types).toContain("session_task_start");
  expect(types).toContain("session_task_end");
});

test("second ask sees the previous task summary in context", async () => {
  const client = new FakeClient([
    "- [ ] step A",
    "first answer",
    "- [ ] step B",
    "second answer",
  ]);
  const session = new Session({ workspaceRoot: root, client });
  await session.ask("first task");
  await session.ask("second task");

  const secondPlannerSystem = client.seen[2][0].content;
  expect(secondPlannerSystem).toContain("Previous conversation");
  expect(secondPlannerSystem).toContain("first task");
  expect(secondPlannerSystem).toContain("first answer");
  expect(
    session.context.workingMemory.checklist.map((item) => item.id),
  ).toEqual(["step B"]);
});

test("ask throws when the session is busy", async () => {
  const session = new Session({ workspaceRoot: root, client: new FakeClient([]) });
  (session as unknown as { running: boolean }).running = true;
  await expect(session.ask("x")).rejects.toThrow(/busy/i);
});

test("save/load round-trips and continues conversation", async () => {
  const sessionPath = path.join(root, ".reallity", "session.json");
  const firstClient = new FakeClient(["- [ ] step A", "first answer"]);
  const session = new Session({
    workspaceRoot: root,
    client: firstClient,
    savePath: sessionPath,
  });
  await session.ask("first task");
  expect(existsSync(sessionPath)).toBe(true);

  const secondClient = new FakeClient(["- [ ] step B", "second answer"]);
  const loaded = await Session.load(sessionPath, {
    workspaceRoot: root,
    client: secondClient,
  });

  expect(loaded.workspace).toBe(await realpath(root));
  expect(loaded.session.tasks).toHaveLength(1);
  expect(loaded.session.bus.history).toEqual(session.bus.history);

  const result = await loaded.session.ask("second task");
  expect(result.success).toBe(true);
  expect(loaded.session.tasks).toHaveLength(2);
  expect(secondClient.seen[0][0].content).toContain("Previous conversation");
});

test("load rejects a workspace mismatch", async () => {
  const sessionPath = path.join(root, "session.json");
  const session = new Session({
    workspaceRoot: root,
    client: new FakeClient([]),
    savePath: sessionPath,
  });
  await session.ask("hi");

  const other = await mkdtemp(path.join(tmpdir(), "reallity-other-"));
  await expect(
    Session.load(sessionPath, { workspaceRoot: other, client: new FakeClient([]) }),
  ).rejects.toThrow(/workspace/i);
});

test("load rejects when the recorded workspace no longer exists", async () => {
  const fileDir = await mkdtemp(path.join(tmpdir(), "reallity-sessionfile-"));
  const sessionPath = path.join(fileDir, "session.json");
  const session = new Session({
    workspaceRoot: root,
    client: new FakeClient([]),
    savePath: sessionPath,
  });
  await session.ask("hi");
  await rm(root, { recursive: true, force: true });

  await expect(
    Session.load(sessionPath, { workspaceRoot: root, client: new FakeClient([]) }),
  ).rejects.toThrow(/no longer exists/i);
});

test("load reuses the provided event bus and seeds its history", async () => {
  const sessionPath = path.join(root, "session.json");
  const session = new Session({
    workspaceRoot: root,
    client: new FakeClient([]),
    savePath: sessionPath,
  });
  await session.ask("hi");

  const bus = new EventBus();
  const loaded = await Session.load(sessionPath, {
    workspaceRoot: root,
    client: new FakeClient([]),
    eventBus: bus,
  });

  expect(loaded.session.bus).toBe(bus);
  expect(bus.history.length).toBeGreaterThan(0);
  expect(bus.history.some((event) => event.type === "session_task_end")).toBe(
    true,
  );
});

test("ask succeeds even when auto-save fails and emits an error event", async () => {
  const bus = new EventBus();
  const session = new Session({
    workspaceRoot: root,
    client: new FakeClient([]),
    eventBus: bus,
    savePath: "/proc/1/forbidden/session.json",
  });
  const result = await session.ask("hi");

  expect(result.success).toBe(true);
  expect(bus.history.some((event) => event.type === "error")).toBe(true);
});

test("task records capture event ranges", async () => {
  const session = new Session({ workspaceRoot: root, client: new FakeClient([]) });
  await session.ask("one");
  const firstEnd = session.tasks[0].eventEnd;
  await session.ask("two");

  expect(session.tasks[1].eventStart).toBe(firstEnd);
  expect(session.tasks[1].eventEnd).toBeGreaterThan(firstEnd);
});

test("ask emits session_task_end even when the agent run throws", async () => {
  const bus = new EventBus();
  const badRoot = await mkdtemp(path.join(tmpdir(), "reallity-nogit-"));
  const session = new Session({
    workspaceRoot: badRoot,
    client: new FakeClient([]),
    eventBus: bus,
  });

  await expect(session.ask("boom")).rejects.toThrow(/git/i);
  const end = bus.history.find((event) => event.type === "session_task_end");
  expect(end).toBeDefined();
  expect(end?.type === "session_task_end" ? end.success : null).toBe(false);
  expect(session.busy).toBe(false);
  await rm(badRoot, { recursive: true, force: true });
});
