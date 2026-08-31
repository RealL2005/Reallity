import { test, expect } from "bun:test";
import {
  ContextManager,
  createInitialWorkingMemory,
  truncateOutput,
} from "../../src/core/context.ts";

test("truncateOutput keeps short output unchanged", () => {
  const output = "line1\nline2";

  expect(truncateOutput(output)).toBe(output);
});

test("truncateOutput keeps head and tail with a marker for long output", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`);
  const output = lines.join("\n");

  const truncated = truncateOutput(output, { headLines: 5, tailLines: 7 });
  const pieces = truncated.split("\n");

  expect(pieces.slice(0, 5)).toEqual([
    "line-0",
    "line-1",
    "line-2",
    "line-3",
    "line-4",
  ]);
  expect(pieces).toContain("... [88 truncated lines] ...");
  expect(pieces.slice(-7)).toEqual([
    "line-93",
    "line-94",
    "line-95",
    "line-96",
    "line-97",
    "line-98",
    "line-99",
  ]);
});

test("ContextManager appends messages and serializes OpenAI format", () => {
  const manager = new ContextManager({
    systemPrompt: "You are a coding agent.",
  });

  manager.appendUser("Add a feature");
  manager.appendAssistant("I will add it", [
    {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    },
  ]);
  manager.appendTool("call_1", "read_file", "hello");

  const messages = manager.serializeOpenAI();

  expect(messages[0]).toEqual({ role: "system", content: "You are a coding agent." });
  expect(messages[1]).toEqual({ role: "user", content: "Add a feature" });
  expect(messages[2]).toMatchObject({
    role: "assistant",
    content: "I will add it",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ],
  });
  expect(messages[3]).toEqual({
    role: "tool",
    tool_call_id: "call_1",
    content: "hello",
  });
});

test("Working memory updates goal, checklist, files, and constraints", () => {
  const memory = createInitialWorkingMemory();
  const manager = new ContextManager({
    systemPrompt: "system",
    workingMemory: memory,
  });

  manager.setCurrentGoal("Build tests");
  manager.addChecklistItems(["write test", "run test"]);
  manager.markChecklistItem("write test", "done");
  manager.addModifiedFile("src/app.ts");
  manager.addConstraint("Node >= 20");

  expect(manager.workingMemory.currentGoal).toBe("Build tests");
  expect(manager.workingMemory.checklist).toEqual([
    { id: "write test", status: "done" },
    { id: "run test", status: "pending" },
  ]);
  expect(manager.workingMemory.modifiedFiles).toEqual(["src/app.ts"]);
  expect(manager.workingMemory.constraints).toEqual(["Node >= 20"]);
});

test("ContextManager truncation preserves system message and drops oldest turns", () => {
  const manager = new ContextManager({
    systemPrompt: "system",
    maxHistoryMessages: 4,
  });

  manager.appendUser("first");
  manager.appendAssistant("second");
  manager.appendUser("third");
  manager.appendAssistant("fourth");
  manager.appendUser("fifth");

  const messages = manager.serializeOpenAI();

  expect(messages[0]).toEqual({ role: "system", content: "system" });
  expect(messages.length).toBe(5);
  expect(messages[1].content).toBe("second");
  expect(messages.at(-1)?.content).toBe("fifth");
});
