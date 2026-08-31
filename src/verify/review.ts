import type { ToolCall } from "../core/context.ts";

export interface ReviewResponse {
  approved: boolean;
  feedback: string;
}

export function parseReviewResponse(content: string): ReviewResponse | null {
  const json = extractJsonObject(content);
  if (!json) {
    return null;
  }

  const value = JSON.parse(json) as Partial<ReviewResponse>;
  if (typeof value.approved !== "boolean") {
    return null;
  }

  return {
    approved: value.approved,
    feedback: typeof value.feedback === "string" ? value.feedback : "",
  };
}

export function reviewResponseFromToolCalls(
  toolCalls: ToolCall[],
): ReviewResponse | null {
  if (toolCalls.length === 0) {
    return null;
  }

  const call = toolCalls[0];
  try {
    const value = JSON.parse(call.function.arguments) as Partial<ReviewResponse>;
    return {
      approved: Boolean(value.approved),
      feedback: typeof value.feedback === "string" ? value.feedback : "",
    };
  } catch {
    return null;
  }
}

function extractJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return content.slice(start, end + 1);
}
