import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReallityAgent, looksLikeReadOnlyTask } from "../src/agent.ts";
import { EventBus } from "../src/observer/events.ts";
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
  await execFileAsync("git", ["add", "file.txt"], { cwd: root });
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
