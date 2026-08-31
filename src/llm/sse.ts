import type {
  ChatCompletionChunk,
  LLMStreamEvent,
} from "./types.ts";

export class SSEParser {
  private buffer = "";

  push(chunk: string): LLMStreamEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: LLMStreamEvent[] = [];
    let boundary = this.buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      events.push(...parseBlock(block));
      boundary = this.buffer.indexOf("\n\n");
    }

    return events;
  }

  flush(): LLMStreamEvent[] {
    if (this.buffer.length === 0) {
      return [];
    }

    const block = this.buffer;
    this.buffer = "";
    return parseBlock(block);
  }
}

function parseBlock(block: string): LLMStreamEvent[] {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return [];
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return [{ type: "done" }];
  }

  try {
    const chunk = JSON.parse(data) as ChatCompletionChunk;
    const events: LLMStreamEvent[] = [];

    for (const choice of chunk.choices) {
      if (typeof choice.delta.content === "string") {
        events.push({
          type: "delta",
          content: choice.delta.content,
          finishReason: choice.finish_reason,
        });
      }

      for (const toolCall of choice.delta.tool_calls ?? []) {
        events.push({
          type: "tool_call_delta",
          toolCall,
          finishReason: choice.finish_reason,
        });
      }
    }

    return events;
  } catch {
    return [{ type: "error", message: `Failed to parse SSE chunk: ${data}` }];
  }
}
