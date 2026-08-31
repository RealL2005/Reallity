import { test, expect } from "bun:test";
import { EventBus, type AgentEvent } from "../../src/observer/events.ts";
import { buildTraceHtml } from "../../src/observer/trace.ts";

test("EventBus emits events to subscribers in order", () => {
  const bus = new EventBus();
  const received: AgentEvent[] = [];

  bus.subscribe((event) => {
    received.push(event);
  });
  bus.emit({ type: "state", state: "planner", timestamp: 1 });
  bus.emit({ type: "tool_start", tool: "read_file", timestamp: 2 });

  expect(received).toHaveLength(2);
  expect(received[0].type).toBe("state");
  expect(received[1].type).toBe("tool_start");
  expect(bus.history).toEqual(received);
});

test("buildTraceHtml contains mermaid state diagram and events", () => {
  const html = buildTraceHtml([
    { type: "state", state: "planner", timestamp: 1 },
    { type: "state", state: "executor", timestamp: 2 },
    { type: "tool_result", tool: "read_file", success: true, timestamp: 3 },
  ]);

  expect(html).toContain('<div class="mermaid">');
  expect(html).toContain("stateDiagram-v2");
  expect(html).toContain("planner");
  expect(html).toContain("executor");
  expect(html).toContain("read_file");
});

test("buildTraceHtml escapes script-tag content", () => {
  const html = buildTraceHtml([
    {
      type: "tool_result",
      tool: "read_file",
      success: true,
      output: "<script>alert(1)</script>",
      timestamp: 1,
    },
  ]);

  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
});
