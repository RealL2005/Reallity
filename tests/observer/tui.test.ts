import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink";
import {
  cleanLlmText,
  formatMarkdownTable,
  isEraseKey,
  parseCommand,
  parseMarkdownTableData,
  buildConversation,
  computeHeights,
  splitLeadingLine,
  stateColor,
  tailLines,
  TuiApp,
} from "../../src/observer/tui.tsx";
import { EventBus, type AgentEvent } from "../../src/observer/events.ts";

test("stateColor gives each FSM state a distinct color", () => {
  const states = [
    "init",
    "planner",
    "executor",
    "verify",
    "commit",
    "rollback",
    "finish",
  ] as const;
  const colors = states.map(stateColor);

  expect(new Set(colors).size).toBeGreaterThan(3);
  expect(stateColor("commit")).toBe("green");
  expect(stateColor("rollback")).toBe("red");
});

test("cleanLlmText removes XML tool calls without truncating long text", () => {
  const long = `line-${"a".repeat(500)}`;
  const content = `<tool_calls><invoke name="bash">x</invoke></tool_calls>${long}`;

  const cleaned = cleanLlmText(content);

  expect(cleaned).not.toContain("<tool_calls>");
  expect(cleaned).toContain(long);
});

test("tailLines keeps the tail and reports omitted lines", () => {
  const content = Array.from({ length: 30 }, (_, index) => `line-${index}`).join(
    "\n",
  );

  const result = tailLines(content, 5);
  const lines = result.split("\n");

  expect(lines[0]).toContain("25 earlier lines hidden");
  expect(lines.slice(1)).toEqual([
    "line-25",
    "line-26",
    "line-27",
    "line-28",
    "line-29",
  ]);
});

test("formatMarkdownTable aligns markdown table columns", () => {
  const result = formatMarkdownTable([
    "| A | B |",
    "|---|---|",
    "| 1 | 22 |",
  ]);

  expect(result[0]).toBe("| A | B  |");
  expect(result[1]).toContain("| -");
  expect(result[2]).toBe("| 1 | 22 |");
});

test("parseMarkdownTableData converts markdown table to structured rows", () => {
  const result = parseMarkdownTableData([
    "| Name | Age |",
    "|------|-----|",
    "| Ada  | 36  |",
  ]);

  expect(result).toEqual([{ Name: "Ada", Age: "36" }]);
});

test("parseCommand routes plain text to ask", () => {
  expect(parseCommand("fix the bug")).toEqual({ type: "ask", text: "fix the bug" });
  expect(parseCommand("/task fix the bug")).toEqual({
    type: "ask",
    text: "fix the bug",
  });
  expect(parseCommand("")).toBeNull();
  expect(parseCommand("   ")).toBeNull();
});

test("parseCommand routes slash commands", () => {
  expect(parseCommand("/run ls -la")).toEqual({ type: "run", command: "ls -la" });
  expect(parseCommand("/bash pwd")).toEqual({ type: "run", command: "pwd" });
  expect(parseCommand("/help")).toEqual({ type: "help" });
  expect(parseCommand("/save")).toEqual({ type: "save", path: undefined });
  expect(parseCommand("/save /tmp/x.json")).toEqual({
    type: "save",
    path: "/tmp/x.json",
  });
  expect(parseCommand("/clear")).toEqual({ type: "clear" });
  expect(parseCommand("/bogus")).toEqual({ type: "unknown", command: "/bogus" });
});

test("buildConversation pairs task start and end events", () => {
  const events: AgentEvent[] = [
    { type: "session_task_start", index: 0, task: "first", timestamp: 1 },
    { type: "session_task_start", index: 1, task: "second", timestamp: 2 },
    {
      type: "session_task_end",
      index: 0,
      task: "first",
      success: true,
      answer: "a1",
      rounds: 2,
      timestamp: 3,
    },
    {
      type: "session_task_end",
      index: 1,
      task: "second",
      success: false,
      answer: "a2",
      rounds: 3,
      timestamp: 4,
    },
  ];

  expect(buildConversation(events)).toEqual([
    { index: 0, task: "first", answer: "a1", success: true },
    { index: 1, task: "second", answer: "a2", success: false },
  ]);
});

test("computeHeights keeps the input bar visible across terminal sizes", () => {
  for (const rows of [16, 24, 30, 40, 60]) {
    const h = computeHeights(rows);
    expect(h.inputHeight).toBeGreaterThanOrEqual(3);
    expect(h.bannerHeight).toBeGreaterThanOrEqual(0);
    expect(h.topologyHeight).toBeGreaterThanOrEqual(0);
    expect(h.llmHeight).toBeGreaterThanOrEqual(4);
    // 内容需要量：summary 文本+页码、token 至少 3 行、workflow 主面板
    expect(h.summaryHeight).toBeGreaterThanOrEqual(3);
    expect(h.workflowHeight).toBeGreaterThanOrEqual(4);
    expect(h.diffHeight).toBeGreaterThanOrEqual(4);
    const leftTotal =
      h.topologyHeight +
      h.conversationHeight +
      h.summaryHeight +
      h.workflowHeight;
    const rightTotal = h.llmHeight + h.tokenHeight + h.diffHeight;
    expect(leftTotal).toBeLessThanOrEqual(h.innerHeight);
    expect(rightTotal).toBeLessThanOrEqual(h.innerHeight);
  }
});

test("computeHeights gives every panel its content at 30+ rows", () => {
  for (const rows of [30, 40, 60]) {
    const h = computeHeights(rows);
    // 面板内容行 = H-3
    expect(h.topologyHeight - 3).toBeGreaterThanOrEqual(1);
    expect(h.conversationHeight - 3).toBeGreaterThanOrEqual(3);
    expect(h.summaryHeight - 3).toBeGreaterThanOrEqual(2);
    expect(h.workflowHeight - 3).toBeGreaterThanOrEqual(5);
    expect(h.llmHeight - 3).toBeGreaterThanOrEqual(5);
    expect(h.tokenHeight - 3).toBeGreaterThanOrEqual(4);
    expect(h.diffHeight - 3).toBeGreaterThanOrEqual(5);
  }
});

test("computeHeights prioritizes the workflow on 24-row terminals", () => {
  const h = computeHeights(24);
  expect(h.topologyHeight).toBe(0);
  expect(h.workflowHeight - 3).toBeGreaterThanOrEqual(5);
  expect(h.summaryHeight - 3).toBeGreaterThanOrEqual(2);
  expect(h.tokenHeight - 3).toBeGreaterThanOrEqual(3);
});

test("isEraseKey recognizes backspace across key formats", () => {
  expect(isEraseKey("", { backspace: true })).toBe(true);
  expect(isEraseKey("", { delete: true })).toBe(true);
  expect(isEraseKey("\u007f", {})).toBe(true);
  expect(isEraseKey("\u0008", {})).toBe(true);
  expect(isEraseKey("a", {})).toBe(false);
  expect(isEraseKey("", {})).toBe(false);
});

test("splitLeadingLine separates batched input at line breaks", () => {
  expect(splitLeadingLine("hi\r")).toEqual({ leading: "hi", hasBreak: true });
  expect(splitLeadingLine("\r")).toEqual({ leading: "", hasBreak: true });
  expect(splitLeadingLine("a\nb")).toEqual({ leading: "a", hasBreak: true });
  expect(splitLeadingLine("hello")).toEqual({
    leading: "hello",
    hasBreak: false,
  });
});

class FakeStdout {
  output = "";
  columns = 80;
  rows = 24;
  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  off(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
}

class FakeStdin {
  isTTY = true;
  isPaused(): boolean {
    return false;
  }
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  read(): null {
    return null;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  off(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  addListener(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  destroy(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
}

test("TUI renders the conversation input bar at 80x24", async () => {
  const bus = new EventBus();
  const stdout = new FakeStdout();
  const instance = render(
    React.createElement(TuiApp, {
      bus,
      task: "",
      workspaceRoot: "/tmp",
      splashMs: 0,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      debug: true,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (
      stdout.output.includes("Reallity") &&
      stdout.output.includes("> ") &&
      stdout.output.includes("[Enter] 发送")
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  expect(stdout.output).toContain("Reallity");
  expect(stdout.output).toContain("> ");
  expect(stdout.output).toContain("[Enter] 发送");
  expect(stdout.output).not.toContain("INTERACTIVE COMMAND INPUT");

  instance.unmount();
});
