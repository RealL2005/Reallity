export type OpenAIRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: OpenAIRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChecklistItem {
  id: string;
  status: "pending" | "in_progress" | "done";
}

export interface WorkingMemory {
  currentGoal: string;
  checklist: ChecklistItem[];
  modifiedFiles: string[];
  constraints: string[];
}

export function createInitialWorkingMemory(): WorkingMemory {
  return {
    currentGoal: "",
    checklist: [],
    modifiedFiles: [],
    constraints: [],
  };
}

export interface TruncateOptions {
  headLines?: number;
  tailLines?: number;
  marker?: string;
}

export function truncateOutput(
  output: string,
  options: TruncateOptions = {},
): string {
  const headLines = options.headLines ?? 20;
  const tailLines = options.tailLines ?? 50;
  const marker = options.marker ?? "[output truncated]";
  const lines = output.split("\n");

  if (lines.length <= headLines + tailLines) {
    return output;
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const truncatedCount = lines.length - headLines - tailLines;

  return [...head, `... [${truncatedCount} truncated lines] ...`, ...tail].join(
    "\n",
  );
}

export interface ContextManagerOptions {
  systemPrompt: string;
  workingMemory?: WorkingMemory;
  maxHistoryMessages?: number;
  maxToolOutputChars?: number;
}

export class ContextManager {
  readonly systemPrompt: string;
  readonly workingMemory: WorkingMemory;
  readonly maxHistoryMessages: number;
  readonly maxToolOutputChars: number;
  private history: OpenAIMessage[] = [];

  constructor(options: ContextManagerOptions) {
    this.systemPrompt = options.systemPrompt;
    this.workingMemory = options.workingMemory ?? createInitialWorkingMemory();
    this.maxHistoryMessages = options.maxHistoryMessages ?? 50;
    this.maxToolOutputChars = options.maxToolOutputChars ?? 8_000;
  }

  appendUser(content: string): void {
    this.history.push({ role: "user", content });
    this.truncateHistory();
  }

  appendAssistant(content: string, toolCalls: ToolCall[] = []): void {
    this.history.push({
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
    this.truncateHistory();
  }

  appendTool(toolCallId: string, _toolName: string, result: string): void {
    const truncated = truncateOutput(result);
    const limited =
      truncated.length > this.maxToolOutputChars
        ? `${truncated.slice(0, this.maxToolOutputChars)}\n... [tool output truncated]`
        : truncated;

    this.history.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: limited,
    });
    this.truncateHistory();
  }

  setCurrentGoal(goal: string): void {
    this.workingMemory.currentGoal = goal;
  }

  addChecklistItems(items: string[]): void {
    for (const item of items) {
      if (!this.workingMemory.checklist.some((entry) => entry.id === item)) {
        this.workingMemory.checklist.push({ id: item, status: "pending" });
      }
    }
  }

  markChecklistItem(
    id: string,
    status: ChecklistItem["status"],
  ): void {
    const item = this.workingMemory.checklist.find((entry) => entry.id === id);
    if (item) {
      item.status = status;
    }
  }

  addModifiedFile(path: string): void {
    if (!this.workingMemory.modifiedFiles.includes(path)) {
      this.workingMemory.modifiedFiles.push(path);
    }
  }

  addConstraint(constraint: string): void {
    if (!this.workingMemory.constraints.includes(constraint)) {
      this.workingMemory.constraints.push(constraint);
    }
  }

  serializeOpenAI(): OpenAIMessage[] {
    return [{ role: "system", content: this.systemPrompt }, ...this.history];
  }

  private truncateHistory(): void {
    if (this.history.length <= this.maxHistoryMessages) {
      return;
    }

    this.history = this.history.slice(-this.maxHistoryMessages);
  }
}
