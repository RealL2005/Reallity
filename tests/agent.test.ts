import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ReallityAgent,
  looksLikeReadOnlyTask,
  subtractPreExistingDiff,
} from "../src/agent.ts";
import { EventBus } from "../src/observer/events.ts";
import { ContextManager } from "../src/core/context.ts";
import type { ChatMessage, LLMResponse } from "../src/llm/types.ts";
import type { VerificationResult } from "../src/verify/runner.ts";
import { parseDiagnostic } from "../src/core/diagnostics.ts";

const execFileAsync = promisify(execFile);

interface ClientLike {
  streamCompletion(
    messages: ChatMessage[],
    options?: Record<string, unknown>,
  ): Promise<LLMResponse>;
}

type ScriptedResponse = Omit<LLMResponse, "reasoningContent"> & {
  reasoningContent?: string;
};

class ScriptedClient implements ClientLike {
  private calls = 0;

  constructor(private readonly scripts: ScriptedResponse[]) {}

  async streamCompletion(): Promise<LLMResponse> {
    const scripted = this.scripts[this.calls];
    const response: LLMResponse = scripted
      ? {
          ...scripted,
          reasoningContent: scripted.reasoningContent ?? "",
        }
      : {
      content: "done",
      reasoningContent: "",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
      },
    };
    this.calls += 1;
    return response;
  }
}

class RecordingClient implements ClientLike {
  readonly seen: ChatMessage[][] = [];
  readonly seenOptions: Array<Record<string, unknown> | undefined> = [];
  private calls = 0;

  constructor(private readonly scripts: ScriptedResponse[]) {}

  async streamCompletion(
    messages: ChatMessage[],
    options?: Record<string, unknown>,
  ): Promise<LLMResponse> {
    this.seen.push(messages);
    this.seenOptions.push(options);
    const scripted = this.scripts[this.calls];
    this.calls += 1;
    return scripted
      ? { ...scripted, reasoningContent: scripted.reasoningContent ?? "" }
      : {
          content: "done",
          reasoningContent: "",
          toolCalls: [],
          finishReason: "stop",
          usage: usage(),
        };
  }
}

function readRounds(count: number): ScriptedResponse[] {
  return Array.from({ length: count }, (_, index) => ({
    content: "",
    toolCalls: [
      {
        id: `call_read_${index}`,
        type: "function" as const,
        function: {
          name: "read_file",
          arguments: JSON.stringify({
            path: "file.txt",
            start_line: 1,
            end_line: (index % 3) + 1,
          }),
        },
      },
    ],
    finishReason: "tool_calls" as const,
    usage: usage(),
  }));
}

function usage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "reallity-agent-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agent@example.com"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "Agent"], {
    cwd: root,
  });
  await writeFile(path.join(root, "file.txt"), "hello\n");
  await writeFile(path.join(root, ".gitignore"), "trace.html\n.reallity/\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("agent plans, executes read_file, verifies, and finishes", async () => {
  const bus = new EventBus();
  const client = new ScriptedClient([
    {
      content: "- [ ] inspect file",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: "",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"file.txt"}' },
        },
      ],
      finishReason: "tool_calls",
      usage: usage(),
    },
    {
      content: "File inspected.",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: '{"approved": true, "feedback": "looks good"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);

  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    runTests: async (): Promise<VerificationResult> => ({
      passed: true,
      exitCode: 0,
      output: "1 pass\n0 fail",
      diagnostics: [],
    }),
  });

  const result = await agent.run("Inspect file.txt");

  expect(result.success).toBe(true);
  expect(result.state).toBe("finish");
  expect(result.tracePath).toMatch(/\.reallity\/traces\/trace-\d+\.html$/);
  expect(bus.history.some((event) => event.type === "tool_start")).toBe(true);
  expect(bus.history.some((event) => event.type === "verification")).toBe(true);
  expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("hello\n");
});

test("agent repairs a failing verification before committing", async () => {
  const bus = new EventBus();
  const client = new ScriptedClient([
    {
      content: "- [ ] fix greeting",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: "",
      toolCalls: [
        {
          id: "call_2",
          type: "function",
          function: {
            name: "edit_file",
            arguments:
              '{"path":"file.txt","old_str":"hello","new_str":"hello world"}',
          },
        },
      ],
      finishReason: "tool_calls",
      usage: usage(),
    },
    {
      content: "I applied the fix.",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: '{"approved": false, "feedback": "tests still fail"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: "Now I see the real issue.",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: '{"approved": true, "feedback": "fixed"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);

  const verificationResults: VerificationResult[] = [
    {
      passed: false,
      exitCode: 1,
      output: [
        "(fail) greeting test",
        "AssertionError: expected",
        " at tests/greeting.test.ts:12:5",
      ].join("\n"),
      diagnostics: [
        parseDiagnostic(
          [
            "(fail) greeting test",
            "AssertionError: expected",
            " at tests/greeting.test.ts:12:5",
          ].join("\n"),
        ),
      ],
    },
    {
      passed: true,
      exitCode: 0,
      output: "1 pass\n0 fail",
      diagnostics: [],
    },
  ];
  let verificationIndex = 0;

  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    runTests: async () => verificationResults[verificationIndex++]!,
  });

  const result = await agent.run("Change hello to hello world");

  expect(result.success).toBe(true);
  expect(verificationIndex).toBe(2);
  expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
    "hello world\n",
  );
  const log = await execFileAsync("git", ["log", "--oneline", "-1"], {
    cwd: root,
  });
  expect(log.stdout).toContain("agent:");
});

test("agent forces verify after repeated tool-calling rounds with changes", async () => {
  const bus = new EventBus();
  const toolA = {
    content: "",
    toolCalls: [
      {
        id: "call_a",
        type: "function" as const,
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "echo a >> file.txt" }),
        },
      },
    ],
    finishReason: "tool_calls",
    usage: usage(),
  };
  const toolB = {
    content: "",
    toolCalls: [
      {
        id: "call_b",
        type: "function" as const,
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "echo b >> file.txt" }),
        },
      },
    ],
    finishReason: "tool_calls",
    usage: usage(),
  };
  const client = new ScriptedClient([
    {
      content: "- [ ] inspect file",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    ...Array.from({ length: 6 }, (_, index) =>
      index % 2 === 0 ? toolA : toolB,
    ),
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);

  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    runTests: async (): Promise<VerificationResult> => ({
      passed: true,
      exitCode: 0,
      output: "1 pass\n0 fail",
      diagnostics: [],
    }),
  });

  const result = await agent.run("Inspect file.txt");

  expect(result.success).toBe(true);
  expect(bus.history.filter((event) => event.type === "tool_start").length).toBe(6);
  expect(bus.history.filter((event) => event.type === "verification").length).toBe(1);
});

test("agent explores without changes past the verify interval", async () => {
  const bus = new EventBus();
  const client = new ScriptedClient([
    {
      content: "- [ ] locate the bug",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    ...readRounds(10),
    {
      content: "定位完成：bug 在 file.txt",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    runTests: async (): Promise<VerificationResult> => ({
      passed: true,
      exitCode: 0,
      output: "1 pass\n0 fail",
      diagnostics: [],
    }),
  });

  const result = await agent.run("定位 file.txt 中的 bug");

  expect(result.success).toBe(true);
  expect(bus.history.filter((event) => event.type === "tool_start").length).toBe(10);
  expect(bus.history.filter((event) => event.type === "verification").length).toBe(1);
});

test("writable task in a dirty workspace does not force verify during reads", async () => {
  const bus = new EventBus();
  await writeFile(path.join(root, "untracked-pre.txt"), "pre-existing\n");
  const client = new ScriptedClient([
    {
      content: "- [ ] inspect file",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    ...readRounds(10),
    {
      content: "已定位，未改动",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    runTests: async (): Promise<VerificationResult> => ({
      passed: true,
      exitCode: 0,
      output: "1 pass\n0 fail",
      diagnostics: [],
    }),
  });

  const result = await agent.run("修改 file.txt 中的内容");

  expect(result.success).toBe(true);
  expect(bus.history.filter((event) => event.type === "tool_start").length).toBe(10);
  expect(bus.history.filter((event) => event.type === "verification").length).toBe(1);
});

test("an early change verifies once and later reads do not force verify again", async () => {
  const bus = new EventBus();
  const editResponse = {
    content: "",
    toolCalls: [
      {
        id: "call_edit",
        type: "function" as const,
        function: {
          name: "edit_file",
          arguments:
            '{"path":"file.txt","old_str":"hello","new_str":"hello world"}',
        },
      },
    ],
    finishReason: "tool_calls" as const,
    usage: usage(),
  };
  const client = new ScriptedClient([
    { content: "- [ ] fix", toolCalls: [], finishReason: "stop", usage: usage() },
    editResponse,
    ...readRounds(5),
    {
      content: '{"approved": false, "feedback": "继续"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    ...readRounds(6),
    { content: "完成", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    runTests: async (): Promise<VerificationResult> => ({
      passed: true,
      exitCode: 0,
      output: "1 pass\n0 fail",
      diagnostics: [],
    }),
  });

  const result = await agent.run("修改 file.txt 中的内容");

  expect(result.success).toBe(true);
  expect(bus.history.filter((event) => event.type === "tool_start").length).toBe(12);
  expect(bus.history.filter((event) => event.type === "verification").length).toBe(2);
});

test("planner output with fake tool-call XML triggers a clean re-plan", async () => {
  const bus = new EventBus();
  const client = new RecordingClient([
    {
      content:
        '<tool_calls><invoke name="bash"><parameter name="command">grep x</parameter></invoke></tool_calls>',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: "- [ ] step A\n- [ ] step B",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    { content: "done", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus });

  const result = await agent.run("do something");

  expect(result.success).toBe(true);
  expect(client.seen[1].map((message) => message.content).join("\n")).toContain(
    "禁止调用工具",
  );
  const checklistEvent = bus.history.find((event) => event.type === "checklist");
  const items =
    checklistEvent?.type === "checklist"
      ? checklistEvent.items.map((item) => item.id)
      : [];
  expect(items).toEqual(["step A", "step B"]);
});

test("planner re-plan is bounded even when fake tool-call XML persists", async () => {
  const bus = new EventBus();
  const client = new RecordingClient([
    {
      content: "<tool_calls>grep x</tool_calls>",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: "<tool_calls>grep y</tool_calls>",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    { content: "done", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus });

  const result = await agent.run("do something");

  expect(result.success).toBe(true);
  expect(client.seen.length).toBe(4);
  const checklistEvent = bus.history.find((event) => event.type === "checklist");
  const items =
    checklistEvent?.type === "checklist"
      ? checklistEvent.items.map((item) => item.id)
      : [];
  expect(items).toEqual(["Complete the requested task"]);
});

test("executor prompt requires real file edits over pasted code", async () => {
  const client = new RecordingClient([
    { content: "- [ ] step", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "done", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({ workspaceRoot: root, client });

  await agent.run("fix something");

  const executorSystem = client.seen[1][0].content;
  expect(executorSystem).toContain("edit_file");
  expect(executorSystem).toContain("pasted code");
});

test("identical consecutive tool calls trip stagnation and roll back", async () => {
  const bus = new EventBus();
  const context = new ContextManager({ systemPrompt: "" });
  const readResponse = {
    content: "",
    toolCalls: [
      {
        id: "call_read",
        type: "function" as const,
        function: { name: "read_file", arguments: '{"path":"file.txt"}' },
      },
    ],
    finishReason: "tool_calls" as const,
    usage: usage(),
  };
  const client = new RecordingClient([
    { content: "- [ ] step", toolCalls: [], finishReason: "stop", usage: usage() },
    readResponse,
    readResponse,
    readResponse,
    { content: "- [ ] retry", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "done", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    context,
  });

  const result = await agent.run("do something");

  expect(result.success).toBe(true);
  expect(bus.history.some((event) => event.type === "rollback")).toBe(true);
  // 第 3 次相同请求在工具执行前即触发回滚，故实际执行 2 次
  expect(bus.history.filter((event) => event.type === "tool_start").length).toBe(2);
  expect(context.workingMemory.constraints.join("\n")).toContain("suspected loop");
});

test("different tool calls do not trip stagnation", async () => {
  const bus = new EventBus();
  const reads = [
    { path: "file.txt" },
    { path: "file.txt", start_line: 1, end_line: 2 },
    { path: "src/agent.ts" },
  ].map((args, index) => ({
    content: "",
    toolCalls: [
      {
        id: `call_${index}`,
        type: "function" as const,
        function: {
          name: "read_file",
          arguments: JSON.stringify(args),
        },
      },
    ],
    finishReason: "tool_calls" as const,
    usage: usage(),
  }));
  const client = new ScriptedClient([
    { content: "- [ ] step", toolCalls: [], finishReason: "stop", usage: usage() },
    ...reads,
    { content: "done", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus });

  const result = await agent.run("do something");

  expect(result.success).toBe(true);
  expect(bus.history.some((event) => event.type === "rollback")).toBe(false);
  expect(bus.history.filter((event) => event.type === "tool_start").length).toBe(3);
});

test("bash nonzero exits are probes and do not trip the breaker", async () => {
  const bus = new EventBus();
  const failResponse = {
    content: "",
    toolCalls: [
      {
        id: "call_bash",
        type: "function" as const,
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "exit 1" }),
        },
      },
    ],
    finishReason: "tool_calls" as const,
    usage: usage(),
  };
  const client = new ScriptedClient([
    { content: "- [ ] probe", toolCalls: [], finishReason: "stop", usage: usage() },
    ...Array.from({ length: 4 }, () => failResponse),
    { content: "done", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    eventBus: bus,
    stagnationLimit: 100,
  });

  const result = await agent.run("do something");

  expect(result.success).toBe(true);
  expect(bus.history.some((event) => event.type === "rollback")).toBe(false);
  expect(bus.history.filter((event) => event.type === "tool_start").length).toBe(4);
});

test("looksLikeReadOnlyTask classifies inspection requests as read-only", () => {
  expect(looksLikeReadOnlyTask("统计当前项目有效代码行数")).toBe(true);
  expect(looksLikeReadOnlyTask("解释 src/agent.ts 的流程")).toBe(true);
  expect(looksLikeReadOnlyTask("实现一个命令行统计工具")).toBe(false);
  expect(looksLikeReadOnlyTask("修复 AST 护栏 bug")).toBe(false);
  expect(
    looksLikeReadOnlyTask("将有效代码行数的统计结果写入 README.md"),
  ).toBe(false);
  expect(looksLikeReadOnlyTask("把统计结果更新到 README.md")).toBe(false);
});

test("injected context renders previous conversation and resets checklist per run", async () => {
  const context = new ContextManager({ systemPrompt: "" });
  const bus = new EventBus();
  const client = new RecordingClient([
    { content: "- [ ] step A", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "first done", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: '{"approved": true, "feedback": "ok"}', toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "- [ ] step B", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "second done", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: '{"approved": true, "feedback": "ok"}', toolCalls: [], finishReason: "stop", usage: usage() },
  ]);

  const first = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus, context });
  await first.run("first task");
  expect(context.workingMemory.checklist.map((item) => item.id)).toEqual(["step A"]);

  context.workingMemory.previousTasks = [{ task: "first task", answer: "first done" }];
  const second = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus, context });
  const result = await second.run("second task");

  expect(result.success).toBe(true);
  const plannerSystem = client.seen[3][0].content;
  expect(plannerSystem).toContain("Previous conversation");
  expect(plannerSystem).toContain("first task");
  expect(plannerSystem).not.toContain("step A");
  expect(context.workingMemory.checklist.map((item) => item.id)).toEqual(["step B"]);
});

test("answers do not leak across agent instances sharing a context", async () => {
  const context = new ContextManager({ systemPrompt: "" });
  const client = new RecordingClient([
    { content: "- [ ] step A", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "first answer", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: '{"approved": true, "feedback": "ok"}', toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "- [ ] step B", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "second answer", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: '{"approved": true, "feedback": "ok"}', toolCalls: [], finishReason: "stop", usage: usage() },
  ]);

  const first = new ReallityAgent({ workspaceRoot: root, client, context });
  const firstResult = await first.run("first");
  const second = new ReallityAgent({ workspaceRoot: root, client, context });
  const secondResult = await second.run("second");

  expect(firstResult.answer).toBe("first answer");
  expect(secondResult.answer).toBe("second answer");
});

test("planner requests no tools while executor keeps tool access", async () => {
  const client = new RecordingClient([
    { content: "- [ ] step", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "done", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: '{"approved": true, "feedback": "ok"}', toolCalls: [], finishReason: "stop", usage: usage() },
  ]);
  const agent = new ReallityAgent({ workspaceRoot: root, client });

  const result = await agent.run("do something");

  expect(result.success).toBe(true);
  expect(client.seenOptions[0]).toEqual({ tools: [] });
  expect(client.seenOptions[1]).toEqual({});
});

test("read-only task completes through semantic approval without running tests", async () => {
  const client = new RecordingClient([
    { content: "- [ ] count lines", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "总行数 100", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: '{"approved": true, "feedback": "ok"}', toolCalls: [], finishReason: "stop", usage: usage() },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    runTests: async (): Promise<VerificationResult> => ({
      passed: false,
      exitCode: 1,
      output: "tests/foo.test.ts:5: error: boom",
      diagnostics: [],
    }),
  });

  const result = await agent.run("统计代码行数");

  expect(result.success).toBe(true);
  expect(result.state).toBe("finish");
  expect(result.answer).toContain("总行数 100");
});

test("read-only executor runs past six tool rounds to a natural summary", async () => {
  const toolCalls = Array.from({ length: 7 }, (_, index) => ({
    content: "",
    toolCalls: [
      {
        id: `c${index}`,
        type: "function" as const,
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: `echo out-${index}` }),
        },
      },
    ],
    finishReason: "tool_calls" as const,
    usage: usage(),
  }));
  const client = new RecordingClient([
    {
      content: "- [ ] plan item",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    ...toolCalls,
    {
      content: "有效代码行数：5466",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    runTests: async (): Promise<VerificationResult> => ({
      passed: false,
      exitCode: 1,
      output: "tests/foo.test.ts:5: error: boom",
      diagnostics: [],
    }),
  });

  const result = await agent.run("统计代码行数");

  expect(result.success).toBe(true);
  expect(result.answer).toBe("有效代码行数：5466");
});

test("answer prefers tool output over partial executor content", async () => {
  const client = new RecordingClient([
    {
      content: "- [ ] plan item",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    {
      content: "partial summary without numbers",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "echo real-answer" }),
          },
        },
      ],
      finishReason: "tool_calls",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    maxInteractions: 2,
  });

  const result = await agent.run("统计代码行数");

  expect(result.success).toBe(false);
  expect(result.answer).toBe("real-answer");
  expect(result.answer).not.toContain("partial summary");
});

test("semantic review can approve work despite failing verification", async () => {
  const client = new RecordingClient([
    { content: "- [ ] step", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "answer ready", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "unrelated flaky failure"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    runTests: async (): Promise<VerificationResult> => ({
      passed: false,
      exitCode: 1,
      output: "tests/foo.test.ts:5: error: flaky",
      diagnostics: [],
    }),
  });

  const result = await agent.run("Change hello to hello world");

  expect(result.success).toBe(true);
  expect(result.state).toBe("finish");
});

test("semantic review rejection sends work back to executor", async () => {
  const client = new RecordingClient([
    { content: "- [ ] step", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "first attempt", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": false, "feedback": "needs more detail"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
    { content: "improved answer", toolCalls: [], finishReason: "stop", usage: usage() },
    {
      content: '{"approved": true, "feedback": "ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    },
  ]);
  const agent = new ReallityAgent({
    workspaceRoot: root,
    client,
    runTests: async (): Promise<VerificationResult> => ({
      passed: true,
      exitCode: 0,
      output: "1 pass\n0 fail",
      diagnostics: [],
    }),
  });

  const result = await agent.run("Change hello to hello world");

  expect(result.success).toBe(true);
  expect(client.seen.length).toBe(5);
  expect(client.seen[3].map((message) => message.content).join("\n")).toContain(
    "needs more detail",
  );
});

test("subtractPreExistingDiff removes untouched pre-existing file diffs", () => {
  const current = [
    "diff --git a/README.md b/README.md",
    "index abc..def 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,3 @@",
    "+new line",
    "diff --git a/src/agent.ts b/src/agent.ts",
    "index 111..222 100644",
    "--- a/src/agent.ts",
    "+++ b/src/agent.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
  ].join("\n");
  const preExisting = [
    "diff --git a/src/agent.ts b/src/agent.ts",
    "index 111..222 100644",
    "--- a/src/agent.ts",
    "+++ b/src/agent.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
  ].join("\n");

  const result = subtractPreExistingDiff(current, preExisting);

  expect(result).toContain("README.md");
  expect(result).not.toContain("src/agent.ts");
});

test("subtractPreExistingDiff keeps everything when there is no pre-existing diff", () => {
  const current = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";

  expect(subtractPreExistingDiff(current, "")).toBe(current);
});
