import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReallityAgent, looksLikeReadOnlyTask } from "../src/agent.ts";
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
  await writeFile(path.join(root, ".gitignore"), "trace.html\n");
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

test("agent forces verify after repeated tool-calling rounds", async () => {
  const bus = new EventBus();
  const toolResponse = {
    content: "",
    toolCalls: [
      {
        id: "call_read",
        type: "function" as const,
        function: { name: "read_file", arguments: '{"path":"file.txt"}' },
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
    toolResponse,
    toolResponse,
    toolResponse,
    toolResponse,
    toolResponse,
    toolResponse,
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
});

test("looksLikeReadOnlyTask classifies inspection requests as read-only", () => {
  expect(looksLikeReadOnlyTask("统计当前项目有效代码行数")).toBe(true);
  expect(looksLikeReadOnlyTask("解释 src/agent.ts 的流程")).toBe(true);
  expect(looksLikeReadOnlyTask("实现一个命令行统计工具")).toBe(false);
  expect(looksLikeReadOnlyTask("修复 AST 护栏 bug")).toBe(false);
});

test("injected context renders previous conversation and resets checklist per run", async () => {
  const context = new ContextManager({ systemPrompt: "" });
  const bus = new EventBus();
  const client = new RecordingClient([
    { content: "- [ ] step A", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "first done", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "- [ ] step B", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "second done", toolCalls: [], finishReason: "stop", usage: usage() },
  ]);

  const first = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus, context });
  await first.run("first task");
  expect(context.workingMemory.checklist.map((item) => item.id)).toEqual(["step A"]);

  context.workingMemory.previousTasks = [{ task: "first task", answer: "first done" }];
  const second = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus, context });
  const result = await second.run("second task");

  expect(result.success).toBe(true);
  const plannerSystem = client.seen[2][0].content;
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
    { content: "- [ ] step B", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "second answer", toolCalls: [], finishReason: "stop", usage: usage() },
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
  ]);
  const agent = new ReallityAgent({ workspaceRoot: root, client });

  const result = await agent.run("do something");

  expect(result.success).toBe(true);
  expect(client.seenOptions[0]).toEqual({ tools: [] });
  expect(client.seenOptions[1]).toEqual({});
});

test("read-only task finishes despite failing verification", async () => {
  const client = new RecordingClient([
    { content: "- [ ] count lines", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "总行数 100", toolCalls: [], finishReason: "stop", usage: usage() },
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
    maxRounds: 3,
  });

  const result = await agent.run("统计代码行数");

  expect(result.success).toBe(false);
  expect(result.answer).toBe("real-answer");
  expect(result.answer).not.toContain("partial summary");
});
