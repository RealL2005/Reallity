import { test, expect } from "bun:test";
import { SSEParser } from "../../src/llm/sse.ts";

test("SSEParser emits a delta event for a complete block", () => {
  const parser = new SSEParser();
  const events = parser.push(
    'data: {"id":"1","choices":[{"index":0,"delta":{"content":"he"},"finish_reason":null}]}\n\n',
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "delta",
    content: "he",
    finishReason: null,
  });
});

test("SSEParser handles chunks split across boundaries", () => {
  const parser = new SSEParser();

  expect(parser.push('data: {"id":"1","choices":[{"index":0,"delta":{"content":"he')).toEqual([]);
  const events = parser.push(
    'llo"},"finish_reason":null}]}\n\n',
  );

  expect(events).toHaveLength(1);
  const event = events[0] as { type: "delta"; content: string };
  expect(event.content).toBe("hello");
});

test("SSEParser emits a done event for [DONE]", () => {
  const parser = new SSEParser();
  const events = parser.push("data: [DONE]\n\n");

  expect(events).toEqual([{ type: "done" }]);
});

test("SSEParser emits tool call deltas", () => {
  const parser = new SSEParser();
  const events = parser.push(
    'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
  );

  expect(events[0]).toMatchObject({
    type: "tool_call_delta",
    toolCall: {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"pa' },
    },
  });
});
