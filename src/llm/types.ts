import type { ToolCall } from "../core/context.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: StreamToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export type LLMStreamEvent =
  | { type: "delta"; content: string; finishReason: string | null }
  | {
      type: "tool_call_delta";
      toolCall: StreamToolCallDelta;
      finishReason?: string | null;
    }
  | { type: "done" }
  | { type: "error"; message: string };

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: LLMUsage;
}
