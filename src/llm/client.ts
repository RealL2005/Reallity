import type {
  ChatMessage,
  LLMResponse,
  LLMStreamEvent,
  LLMUsage,
  StreamToolCallDelta,
} from "./types.ts";
import type { ToolCall } from "../core/context.ts";
import { SSEParser } from "./sse.ts";
import { retryWithBackoff } from "./retry.ts";
import type { ToolSchemaEntry } from "../tools/schemas.ts";

export class LLMClientError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LLMClientError";
  }
}

export interface OpenAICompatibleClientOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  tools?: ToolSchemaEntry[];
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface StreamCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchemaEntry[];
  stream: true;
  temperature?: number;
  max_tokens?: number;
}

export function buildChatRequestBody(
  messages: ChatMessage[],
  tools: ToolSchemaEntry[],
  options: {
    model: string;
    temperature?: number;
    maxTokens?: number;
  },
): ChatRequestBody {
  return {
    model: options.model,
    messages,
    tools,
    stream: true,
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
  };
}

export class OpenAICompatibleClient {
  private readonly baseURL: string;

  constructor(private readonly options: OpenAICompatibleClientOptions) {
    this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
  }

  async streamCompletion(
    messages: ChatMessage[],
    options: StreamCompletionOptions = {},
  ): Promise<LLMResponse> {
    const tools = this.options.tools ?? [];
    const model = options.model ?? this.options.model;
    const body = buildChatRequestBody(messages, tools, {
      model,
      temperature: options.temperature ?? this.options.temperature,
      maxTokens: options.maxTokens ?? this.options.maxTokens,
    });

    const response = await retryWithBackoff(
      () => this.request(body),
      {
        shouldRetry: (error) =>
          error instanceof LLMClientError && error.retryable,
      },
    );

    return this.readResponse(response);
  }

  private async request(body: ChatRequestBody): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = this.joinUrl(this.baseURL, "chat/completions");
    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new LLMClientError(
        error instanceof Error ? error.message : String(error),
        undefined,
        true,
      );
    }

    if (!response.ok) {
      const text = await response.text();
      throw new LLMClientError(
        `LLM request failed (${response.status}): ${text}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    return response;
  }

  private async readResponse(response: Response): Promise<LLMResponse> {
    if (!response.body) {
      throw new LLMClientError("LLM response has no body", response.status, false);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    let content = "";
    let finishReason = "";
    let usage: LLMUsage = emptyUsage();
    const toolCalls: ToolCall[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const events = parser.push(decoder.decode(value, { stream: true }));
      this.consumeEvents(events, {
        onContent: (piece) => {
          content += piece;
        },
        onFinish: (reason) => {
          if (reason) {
            finishReason = reason;
          }
        },
        onUsage: (next) => {
          usage = mergeUsage(usage, next);
        },
        onToolCall: (delta) => {
          applyToolCallDelta(toolCalls, delta);
        },
      });
    }

    this.consumeEvents(parser.flush(), {
      onContent: (piece) => {
        content += piece;
      },
      onFinish: (reason) => {
        if (reason) {
          finishReason = reason;
        }
      },
      onUsage: (next) => {
        usage = mergeUsage(usage, next);
      },
      onToolCall: (delta) => {
        applyToolCallDelta(toolCalls, delta);
      },
    });

    return {
      content,
      toolCalls,
      finishReason: finishReason || "stop",
      usage,
    };
  }

  private consumeEvents(
    events: LLMStreamEvent[],
    handlers: {
      onContent: (content: string) => void;
      onFinish: (reason: string | null) => void;
      onUsage: (usage: Partial<LLMUsage>) => void;
      onToolCall: (delta: StreamToolCallDelta) => void;
    },
  ): void {
    for (const event of events) {
      if (event.type === "delta") {
        handlers.onContent(event.content);
        handlers.onFinish(event.finishReason);
      } else if (event.type === "tool_call_delta") {
        handlers.onToolCall(event.toolCall);
        handlers.onFinish(event.finishReason ?? null);
      }
    }
  }

  private joinUrl(base: string, path: string): string {
    return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  }
}

function applyToolCallDelta(toolCalls: ToolCall[], delta: StreamToolCallDelta): void {
  let toolCall = toolCalls[delta.index];
  if (!toolCall) {
    toolCall = {
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    toolCalls[delta.index] = toolCall;
  }

  if (delta.id) {
    toolCall.id = delta.id;
  }
  if (delta.type) {
    toolCall.type = delta.type;
  }
  if (delta.function?.name) {
    toolCall.function.name += delta.function.name;
  }
  if (delta.function?.arguments) {
    toolCall.function.arguments += delta.function.arguments;
  }
}

function emptyUsage(): LLMUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
  };
}

function mergeUsage(
  current: LLMUsage,
  next: Partial<LLMUsage>,
): LLMUsage {
  return {
    promptTokens: next.promptTokens ?? current.promptTokens,
    completionTokens: next.completionTokens ?? current.completionTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
    promptCacheHitTokens:
      next.promptCacheHitTokens ?? current.promptCacheHitTokens,
    promptCacheMissTokens:
      next.promptCacheMissTokens ?? current.promptCacheMissTokens,
  };
}
