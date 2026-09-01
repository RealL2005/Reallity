import { test, expect } from "bun:test";
import {
  cleanLlmText,
  formatMarkdownTable,
  parseCommand,
  parseMarkdownTableData,
  buildConversation,
  stateColor,
  tailLines,
} from "../../src/observer/tui.tsx";
import type { AgentEvent } from "../../src/observer/events.ts";

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
