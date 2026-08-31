import { test, expect } from "bun:test";
import {
  buildChatRequestBody,
  OpenAICompatibleClient,
} from "../../src/llm/client.ts";
import type { OpenAIMessage } from "../../src/core/context.ts";
import type { ToolSchemaEntry } from "../../src/tools/schemas.ts";

const tools: ToolSchemaEntry[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

test("buildChatRequestBody includes model, messages, tools, and streaming", () => {
  const messages: OpenAIMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
  ];

  const body = buildChatRequestBody(messages, tools, {
    model: "gpt-4.1",
    temperature: 0.2,
  });

  expect(body).toMatchObject({
    model: "gpt-4.1",
    messages,
    tools,
    stream: true,
    temperature: 0.2,
  });
});

test("buildChatRequestBody omits the tools field when the list is empty", () => {
  const body = buildChatRequestBody(
    [{ role: "user", content: "hello" }],
    [],
    { model: "test" },
  );

  expect(body).not.toHaveProperty("tools");
});

test("streamCompletion accumulates content and tool call arguments", async () => {
  const sse = [
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const client = new OpenAICompatibleClient({
    apiKey: "test-key",
    baseURL: "https://example.com/v1",
    model: "test",
    tools,
    fetchImpl: async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });

  const response = await client.streamCompletion([
    { role: "user", content: "read a.ts" },
  ]);

  expect(response.content).toBe("Hello");
  expect(response.reasoningContent).toBe("think");
  expect(response.finishReason).toBe("tool_calls");
  expect(response.toolCalls).toHaveLength(1);
  expect(response.toolCalls[0].function.name).toBe("read_file");
  expect(response.toolCalls[0].function.arguments).toBe('{"path":"a.ts"}');
});
