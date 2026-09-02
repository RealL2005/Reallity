import { ContextManager } from "./core/context.ts";
import type { ToolCall } from "./core/context.ts";
import type { ChatMessage, LLMResponse } from "./llm/types.ts";
import type { StreamCompletionOptions } from "./llm/client.ts";
import { CircuitBreaker, FSMEngine } from "./fsm/engine.ts";
import { extractChecklist } from "./fsm/planner.ts";
import { executeTool } from "./tools/executor.ts";
import type { ToolResult } from "./tools/executor.ts";
import { isMutatingBashCommand } from "./tools/guards.ts";
import { EventBus } from "./observer/events.ts";
import { GitCheckpoint } from "./governance/checkpoint.ts";
import type { CheckpointSnapshot } from "./governance/checkpoint.ts";
import {
  buildReviewPrompt,
  buildVerificationResult,
  runBunTests,
  runVerification,
  type VerificationResult,
} from "./verify/runner.ts";
import { parseReviewResponse, type ReviewResponse } from "./verify/review.ts";
import { buildTraceHtml } from "./observer/trace.ts";

export interface LLMClientLike {
  streamCompletion(
    messages: ChatMessage[],
    options?: StreamCompletionOptions,
  ): Promise<LLMResponse>;
}

export type RunTests = (workspaceRoot: string) => Promise<VerificationResult>;

export interface ReallityAgentOptions {
  workspaceRoot: string;
  client: LLMClientLike;
  eventBus?: EventBus;
  context?: ContextManager;
  runTests?: RunTests;
  maxInteractions?: number;
  commitMessagePrefix?: string;
}

export interface AgentRunResult {
  success: boolean;
  state: string;
  message: string;
  answer: string;
  rounds: number;
  tracePath: string;
}

export class ReallityAgent {
  private readonly workspaceRoot: string;
  private readonly client: LLMClientLike;
  private readonly eventBus: EventBus;
  private readonly context: ContextManager;
  private readonly fsm: FSMEngine;
  private readonly breaker: CircuitBreaker;
  private readonly checkpoint: GitCheckpoint;
  private readonly runTests: RunTests;
  private readonly commitMessagePrefix: string;
  private toolRounds = 0;
  private readOnly = false;
  private finalAnswer = "";
  private lastLlmContent = "";
  private toolChainSummary = "";
  private lastToolOutput = "";
  private checkpointSnapshot?: CheckpointSnapshot;

  constructor(options: ReallityAgentOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.client = options.client;
    this.eventBus = options.eventBus ?? new EventBus();
    this.fsm = new FSMEngine({ maxInteractions: options.maxInteractions });
    this.breaker = new CircuitBreaker(3);
    this.checkpoint = new GitCheckpoint(options.workspaceRoot);
    this.context =
      options.context ??
      new ContextManager({
        systemPrompt: "",
        maxHistoryMessages: 60,
      });
    this.runTests = options.runTests ?? ((root) => runVerification(root));
    this.commitMessagePrefix = options.commitMessagePrefix ?? "agent";
  }

  async run(task: string): Promise<AgentRunResult> {
    const started = Date.now();
    this.finalAnswer = "";
    this.lastLlmContent = "";
    this.toolChainSummary = "";
    this.lastToolOutput = "";
    this.toolRounds = 0;
    this.readOnly = looksLikeReadOnlyTask(task);
    this.context.resetChecklist();
    this.emit({ type: "state", state: "init", timestamp: started });
    this.context.appendUser(task);
    const snapshot = await this.checkpoint.capture();
    this.checkpointSnapshot = snapshot;
    this.emit({
      type: "checkpoint",
      head: snapshot.head,
      clean: snapshot.clean,
      timestamp: Date.now(),
    });

    try {
      while (this.fsm.state !== "finish") {
        switch (this.fsm.state) {
          case "init":
            this.transition("planner");
            break;
          case "planner":
            await this.plan();
            break;
          case "executor":
            await this.execute();
            break;
          case "verify":
            await this.verify(task);
            break;
          case "commit":
            await this.commit(task);
            break;
          case "rollback":
            await this.rollbackAndReplan();
            break;
        }
      }

      const message = "Task completed.";
      const answer =
        this.finalAnswer ||
        this.lastToolOutput ||
        this.lastLlmContent ||
        this.toolChainSummary ||
        message;
      this.emit({
        type: "finish",
        success: true,
        message,
        answer,
        timestamp: Date.now(),
      });
      return {
        success: true,
        state: this.fsm.state,
        message,
        answer,
        rounds: this.fsm.interactionCount,
        tracePath: this.writeTrace(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "error",
        message,
        timestamp: Date.now(),
      });
      return {
        success: false,
        state: this.fsm.state,
        message,
        answer:
          this.finalAnswer ||
          this.lastToolOutput ||
          this.lastLlmContent ||
          this.toolChainSummary,
        rounds: this.fsm.interactionCount,
        tracePath: this.writeTrace(),
      };
    }
  }

  private async plan(): Promise<void> {
    const response = await this.complete("planner");
    this.context.appendAssistant(
      response.content,
      response.toolCalls,
      response.reasoningContent,
    );
    const checklist = extractChecklist(response.content);
    this.context.addChecklistItems(
      checklist.length > 0 ? checklist : ["Complete the requested task"],
    );
    this.emit({
      type: "checklist",
      items: this.context.workingMemory.checklist,
      timestamp: Date.now(),
    });
    this.context.setCurrentGoal(this.context.workingMemory.currentGoal || "Task");
    this.transition("executor");
  }

  private async execute(): Promise<void> {
    const response = await this.complete("executor");
    this.context.appendAssistant(
      response.content,
      response.toolCalls,
      response.reasoningContent,
    );

    if (response.toolCalls.length === 0) {
      if (response.content.trim()) {
        this.finalAnswer = response.content.trim();
      }
      this.toolRounds = 0;
      this.transition("verify");
      return;
    }

    this.toolRounds += 1;

    for (const call of response.toolCalls) {
      const args = parseToolArguments(call.function.arguments);
      this.emit({
        type: "tool_start",
        tool: call.function.name as never,
        args,
        timestamp: Date.now(),
      });

      const result = await this.executeCall(call);

      this.emit({
        type: "tool_result",
        tool: call.function.name as never,
        success: result.success,
        output: result.output,
        error: result.error,
        diff: result.diff,
        timestamp: Date.now(),
      });

      this.context.appendTool(
        call.id,
        call.function.name,
        result.success ? result.output : (result.error ?? "tool failed"),
      );
      if (result.success && result.output.trim()) {
        this.lastToolOutput = result.output.trim();
      }
      this.toolChainSummary = `${call.function.name}${
        result.success ? "" : " (failed)"
      }`;

      if (call.function.name === "edit_file" && result.success) {
        this.context.addModifiedFile(extractPath(call.function.arguments));
      }

      if (!result.success) {
        this.breaker.recordError(
          `${call.function.name}: ${result.error ?? "unknown error"}`,
        );
      }
    }

    if (this.toolRounds >= 6 && !this.readOnly) {
      this.toolRounds = 0;
      this.transition("verify");
    }
  }

  private async executeCall(
    call: ToolCall,
  ): Promise<ToolResult> {
    if (this.readOnly && call.function.name === "edit_file") {
      return {
        toolCallId: call.id,
        name: "edit_file",
        output: "",
        success: false,
        error: "READ-ONLY task forbids edit_file.",
      };
    }

    if (this.readOnly && call.function.name === "bash") {
      const args = JSON.parse(call.function.arguments || "{}") as {
        command?: string;
      };
      if (isMutatingBashCommand(args.command ?? "")) {
        return {
          toolCallId: call.id,
          name: "bash",
          output: "",
          success: false,
          error: "READ-ONLY task forbids mutating bash commands.",
        };
      }
    }

    return executeTool(call, {
      workspaceRoot: this.workspaceRoot,
    });
  }

  private async verify(task: string): Promise<void> {
    let verification: VerificationResult;
    if (this.readOnly) {
      verification = {
        passed: true,
        exitCode: 0,
        output: "Read-only task: tests skipped; semantic review gates completion.",
        diagnostics: [],
      };
    } else {
      verification = await this.runTests(this.workspaceRoot);
    }
    this.emit({
      type: "verification",
      passed: verification.passed,
      output: verification.output,
      timestamp: Date.now(),
    });

    if (!verification.passed && verification.diagnostics.length > 0) {
      this.emit({
        type: "diagnostic",
        diagnostic: verification.diagnostics[0],
        timestamp: Date.now(),
      });
    }

    const review = await this.semanticVerify(task, verification);
    this.emit({
      type: "review",
      approved: Boolean(review?.approved),
      feedback: review?.feedback ?? "",
      timestamp: Date.now(),
    });
    if (review?.approved) {
      this.transition("commit");
      return;
    }

    this.context.appendUser(
      `Code review requested changes: ${review?.feedback || "not approved"}`,
    );
    if (!verification.passed && !looksLikeNoTests(verification.output)) {
      this.context.appendUser(`Verification output:\n${verification.output}`);
    }
    this.breaker.recordError("semantic review rejected");

    if (this.breaker.isTripped) {
      this.transition("rollback");
      return;
    }

    this.transition("executor");
  }

  private async semanticVerify(
    task: string,
    verification: VerificationResult,
  ): Promise<ReviewResponse | null> {
    const [diff, status] = await Promise.all([
      this.checkpoint.diff(),
      this.checkpoint.status(),
    ]);
    const untrackedFiles = status
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(2).trim());
    const agentDiff = subtractPreExistingDiff(
      diff,
      this.checkpointSnapshot?.pendingDiff ?? "",
    );
    const reviewDiff = [
      agentDiff,
      untrackedFiles.length > 0
        ? `Untracked files:\n${untrackedFiles.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const files = [...this.context.workingMemory.modifiedFiles];
    const answer =
      this.finalAnswer || this.lastToolOutput || this.lastLlmContent || "";
    const prompt = buildReviewPrompt({
      requirement: task,
      diff: reviewDiff,
      files,
      answer,
      verification: verification.output,
    });
    this.fsm.recordInteraction();
    const response = await this.client.streamCompletion(
      [
        {
          role: "user",
          content: prompt,
        },
      ],
      { tools: [] },
    );
    return parseReviewResponse(response.content);
  }

  private async commit(task: string): Promise<void> {
    if (this.readOnly) {
      this.transition("finish");
      return;
    }

    if (await this.checkpoint.hasChanges()) {
      await this.checkpoint.commitAll(`${this.commitMessagePrefix}: ${task}`);
    }
    this.transition("finish");
  }

  private async rollbackAndReplan(): Promise<void> {
    await this.checkpoint.rollback();
    this.emit({
      type: "rollback",
      success: true,
      message: "Working tree rolled back to checkpoint.",
      timestamp: Date.now(),
    });
    this.breaker.reset();
    this.context.addConstraint("Previous attempt was rolled back.");
    this.transition("planner");
  }

  private async complete(
    mode: "planner" | "executor",
  ): Promise<LLMResponse> {
    this.fsm.recordInteraction();
    const response = await this.client.streamCompletion(
      this.buildMessages(mode),
      mode === "planner" ? { tools: [] } : {},
    );
    if (response.content.trim() && mode === "executor") {
      this.lastLlmContent = response.content.trim();
    }
    this.emit({
      type: "llm",
      content: response.content,
      toolCalls: response.toolCalls,
      usage: response.usage,
      timestamp: Date.now(),
    });
    return response;
  }

  private buildMessages(mode: "planner" | "executor"): ChatMessage[] {
    const messages = this.context.serializeOpenAI();
    messages[0] = {
      ...messages[0],
      content: this.buildSystemPrompt(mode),
    };
    return messages;
  }

  private buildSystemPrompt(mode: "planner" | "executor"): string {
    const memory = this.context.workingMemory;
    const checklist = memory.checklist
      .map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.id}`)
      .join("\n");
    const previousTasks = memory.previousTasks
      .map(
        (entry) =>
          `- ${truncateChars(entry.task, 200)} → ${truncateChars(entry.answer, 500)}`,
      )
      .join("\n");

    const plannerRules = [
      "You are in PLANNER state.",
      "Analyze the user's task and produce a concise checklist of actionable steps.",
      "Each checklist item must start with '- [ ]'.",
      "Do NOT call tools in this state.",
      "After the checklist, stop.",
    ].join("\n");
    const executorRules = [
      "You are in EXECUTOR state.",
      "Work only on the current incomplete checklist item.",
      "Use tools when you need to read or modify the repository.",
      "After receiving tool results, decide whether the current item is complete.",
      "If the current item is complete, respond with a short final summary and NO tool calls.",
      "Do not repeat completed work or call unnecessary read-only tools.",
    ].join("\n");
    const readOnlyRules = this.readOnly
      ? [
          "READ-ONLY TASK. Do not create, modify, or delete files.",
          "Do not run mutating bash commands such as mkdir, rm, cat >, git add, npm install, or sed -i.",
          "Use read_file, list_dir, glob, and non-mutating bash commands to inspect and compute the answer.",
          "When you have the answer, output it and call NO tools.",
        ].join("\n")
      : "";

    return [
      "You are Reallity, a native coding agent harness.",
      "Interpret the user's request first.",
      "If the task asks for information, statistics, explanation, or inspection, DO NOT create or modify files; answer directly and then stop with no tool calls.",
      "Only create or modify files when the user explicitly asks to build, add, change, fix, or refactor code.",
      readOnlyRules,
      mode === "planner" ? plannerRules : executorRules,
      "",
      `Current goal: ${memory.currentGoal || "Follow the user's request"}`,
      "",
      "Checklist:",
      checklist || "- [ ] Complete the requested task",
      "",
      previousTasks ? `Previous conversation:\n${previousTasks}` : "",
      "",
      `Modified files: ${memory.modifiedFiles.join(", ") || "none"}`,
      `Project constraints: ${memory.constraints.join("; ") || "none"}`,
    ].join("\n");
  }

  private transition(next: Parameters<FSMEngine["transition"]>[0]): void {
    this.fsm.transition(next);
    this.emit({
      type: "state",
      state: this.fsm.state,
      timestamp: Date.now(),
    });
  }

  private emit(event: Parameters<EventBus["emit"]>[0]): void {
    this.eventBus.emit(event);
  }

  private writeTrace(): string {
    const tracePath = `${this.workspaceRoot}/trace.html`;
    const html = buildTraceHtml(this.eventBus.history);
    Bun.write(tracePath, html);
    return tracePath;
  }
}

function looksLikeNoTests(output: string): boolean {
  return /\b0 tests\b|No tests found/i.test(output);
}

export function subtractPreExistingDiff(
  current: string,
  preExisting: string,
): string {
  if (!preExisting) {
    return current;
  }
  const preSections = splitDiffSections(preExisting);
  if (preSections.length === 0) {
    return current;
  }
  return splitDiffSections(current)
    .filter((section) => !preSections.includes(section))
    .join("");
}

function splitDiffSections(diff: string): string[] {
  const trimmed = diff.trim();
  if (!trimmed) {
    return [];
  }
  const lines = trimmed.split("\n");
  const sections: string[] = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && lines[index].startsWith("diff --git ")) {
      sections.push(lines.slice(start, index).join("\n"));
      start = index;
    }
  }
  sections.push(lines.slice(start).join("\n"));
  return sections;
}

function extractPath(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as { path?: string };
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    return "";
  }
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function truncateChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function looksLikeReadOnlyTask(task: string): boolean {
  const readOnlyWords = [
    "统计",
    "计算",
    "解释",
    "分析",
    "查看",
    "列出",
    "检查",
    "多少",
    "多少行",
    "是否有",
    "找出",
    "总结",
  ];
  const changeWords = [
    "实现",
    "创建",
    "添加",
    "新增",
    "修改",
    "修复",
    "重构",
    "删除",
    "写一个",
    "写入",
    "写进",
    "写到",
    "写回",
    "更新",
    "追加",
    "编辑",
    "改动",
    "记录到",
    "保存到",
    "输出到",
    "开发",
    "build",
    "add",
    "fix",
    "implement",
    "write",
    "update",
  ];
  const hasChangeIntent = changeWords.some((word) => task.includes(word));
  const hasReadOnlyIntent = readOnlyWords.some((word) => task.includes(word));

  return hasReadOnlyIntent && !hasChangeIntent;
}
