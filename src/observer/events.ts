import type { AgentState } from "../fsm/types.ts";
import type { ToolName } from "../tools/schemas.ts";
import type { ToolCall } from "../core/context.ts";
import type { ChecklistItem } from "../core/context.ts";
import type { Diagnostic } from "../core/diagnostics.ts";
import type { LLMUsage } from "../llm/types.ts";

export type AgentEvent =
  | { type: "state"; state: AgentState; timestamp: number }
  | {
      type: "llm";
      content: string;
      toolCalls: ToolCall[];
      usage: LLMUsage;
      timestamp: number;
    }
  | {
      type: "tool_start";
      tool: ToolName;
      args?: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "tool_result";
      tool: ToolName;
      success: boolean;
      output?: string;
      error?: string;
      code?: string;
      diff?: {
        path: string;
        oldText: string;
        newText: string;
      };
      timestamp: number;
    }
  | {
      type: "verification";
      passed: boolean;
      output?: string;
      timestamp: number;
    }
  | { type: "diagnostic"; diagnostic: Diagnostic; timestamp: number }
  | { type: "checkpoint"; head: string; clean: boolean; timestamp: number }
  | { type: "checklist"; items: ChecklistItem[]; timestamp: number }
  | { type: "rollback"; success: boolean; message: string; timestamp: number }
  | { type: "error"; message: string; timestamp: number }
  | {
      type: "finish";
      success: boolean;
      message: string;
      answer?: string;
      timestamp: number;
    }
  | {
      type: "session_task_start";
      index: number;
      task: string;
      timestamp: number;
    }
  | {
      type: "session_task_end";
      index: number;
      task: string;
      success: boolean;
      answer: string;
      rounds: number;
      timestamp: number;
    }
  | { type: "notice"; message: string; timestamp: number }
  | {
      type: "review";
      approved: boolean;
      feedback: string;
      timestamp: number;
    };

type EventListener = (event: AgentEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  private events: AgentEvent[];

  constructor(options: { initialEvents?: AgentEvent[] } = {}) {
    this.events = [...(options.initialEvents ?? [])];
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  seed(events: AgentEvent[]): void {
    this.events.push(...events);
  }

  get history(): AgentEvent[] {
    return [...this.events];
  }
}
