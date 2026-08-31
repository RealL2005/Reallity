import { test, expect } from "bun:test";
import { cleanLlmText, stateColor } from "../../src/observer/tui.tsx";

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
