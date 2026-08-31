import { executeTool, type ExecutorContext, type ToolResult } from "./executor.ts";
import type { ToolCall } from "../core/context.ts";

export class ToolRegistry {
  constructor(private readonly context: ExecutorContext) {}

  execute(call: ToolCall): Promise<ToolResult> {
    return executeTool(call, this.context);
  }
}
