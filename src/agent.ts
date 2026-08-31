import { ContextManager } from "./core/context.ts";
import type { ChatMessage, LLMResponse } from "./llm/types.ts";
import type { StreamCompletionOptions } from "./llm/client.ts";
import { CircuitBreaker, FSMEngine } from "./fsm/engine.ts";
import { extractChecklist } from "./fsm/planner.ts";
import { executeTool } from "./tools/executor.ts";
import { EventBus } from "./observer/events.ts";
import { GitCheckpoint } from "./governance/checkpoint.ts";
import {
  buildReviewPrompt,
  buildVerificationResult,
  runBunTests,
  type VerificationResult,
} from "./verify/runner.ts";
import { parseReviewResponse } from "./verify/review.ts";
import { parseDiagnostic } from "./core/diagnostics.ts";
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
  runTests?: RunTests;
  maxRounds?: number;
  commitMessagePrefix?: string;
}

export interface AgentRunResult {
  success: boolean;
  state: string;
  message: string;
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

  constructor(options: ReallityAgentOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.client = options.client;
    this.eventBus = options.eventBus ?? new EventBus();
    this.fsm = new FSMEngine({ maxRounds: options.maxRounds });
    this.breaker = new CircuitBreaker(3);
    this.checkpoint = new GitCheckpoint(options.workspaceRoot);
    this.context = new ContextManager({
      systemPrompt: "",
      maxHistoryMessages: 60,
    });
    this.runTests = options.runTests ?? ((root) => runBunTests(root));
    this.commitMessagePrefix = options.commitMessagePrefix ?? "agent";
  }

  async run(task: string): Promise<AgentRunResult> {
    const started = Date.now();
    this.emit({ type: "state", state: "init", timestamp: started });
    this.context.appendUser(task);
    const snapshot = await this.checkpoint.capture();
    this.emit({
      type: "checkpoint",
      head: snapshot.head,
      clean: snapshot.clean,
      timestamp: Date.now(),
    });

    try {
      while (this.fsm.state !== "finish") {
        this.fsm.recordRound();

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
      this.emit({
        type: "finish",
        success: true,
        timestamp: Date.now(),
      });
      return {
        success: true,
        state: this.fsm.state,
        message,
        rounds: this.fsm.roundCount,
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
        rounds: this.fsm.roundCount,
        tracePath: this.writeTrace(),
      };
    }
  }

  private async plan(): Promise<void> {
    const response = await this.complete();
    this.context.appendAssistant(
      response.content,
      response.toolCalls,
      response.reasoningContent,
    );
    const checklist = extractChecklist(response.content);
    this.context.addChecklistItems(
      checklist.length > 0 ? checklist : ["Complete the requested task"],
    );
    this.context.setCurrentGoal(this.context.workingMemory.currentGoal || "Task");
    this.transition("executor");
  }

  private async execute(): Promise<void> {
    const response = await this.complete();
    this.context.appendAssistant(
      response.content,
      response.toolCalls,
      response.reasoningContent,
    );

    if (response.toolCalls.length === 0) {
      this.toolRounds = 0;
      this.transition("verify");
      return;
    }

    this.toolRounds += 1;

    for (const call of response.toolCalls) {
      this.emit({
        type: "tool_start",
        tool: call.function.name as never,
        timestamp: Date.now(),
      });

      const result = await executeTool(call, {
        workspaceRoot: this.workspaceRoot,
      });

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

      if (call.function.name === "edit_file" && result.success) {
        this.context.addModifiedFile(extractPath(call.function.arguments));
      }

      if (!result.success) {
        this.breaker.recordError(
          `${call.function.name}: ${result.error ?? "unknown error"}`,
        );
      }
    }

    if (this.toolRounds >= 6) {
      this.toolRounds = 0;
      this.transition("verify");
    }
  }

  private async verify(task: string): Promise<void> {
    const verification = await this.runTests(this.workspaceRoot);
    this.emit({
      type: "verification",
      passed: verification.passed,
      output: verification.output,
      timestamp: Date.now(),
    });

    if (verification.passed || looksLikeNoTests(verification.output)) {
      await this.review(task);
      return;
    }

    const diagnostic =
      verification.diagnostics[0] ?? parseDiagnostic(verification.output);
    this.emit({
      type: "diagnostic",
      diagnostic,
      timestamp: Date.now(),
    });
    this.context.appendUser(
      `Verification failed:\n${verification.output}\nFix the test failures.`,
    );
    this.breaker.recordError(signatureOf(diagnostic));

    if (this.breaker.isTripped) {
      this.transition("rollback");
      return;
    }

    this.transition("executor");
  }

  private async review(task: string): Promise<void> {
    const [diff, status] = await Promise.all([
      this.checkpoint.diff(),
      this.checkpoint.status(),
    ]);
    const untrackedFiles = status
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(2).trim());
    const reviewDiff = [
      diff,
      untrackedFiles.length > 0
        ? `Untracked files:\n${untrackedFiles.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const files = [...this.context.workingMemory.modifiedFiles];
    const prompt = buildReviewPrompt({
      requirement: task,
      diff: reviewDiff,
      files,
    });
    const response = await this.client.streamCompletion(
      [
        {
          role: "user",
          content: prompt,
        },
      ],
      { tools: [] },
    );
    const review = parseReviewResponse(response.content);

    if (review?.approved) {
      this.transition("commit");
      return;
    }

    this.context.appendUser(
      `Code review requested changes: ${review?.feedback ?? response.content}`,
    );
    this.transition("executor");
  }

  private async commit(task: string): Promise<void> {
    if (await this.checkpoint.hasChanges()) {
      await this.checkpoint.commitAll(`${this.commitMessagePrefix}: ${task}`);
    }
    this.transition("finish");
  }

  private async rollbackAndReplan(): Promise<void> {
    await this.checkpoint.rollback();
    this.breaker.reset();
    this.context.addConstraint("Previous attempt was rolled back.");
    this.transition("planner");
  }

  private async complete(): Promise<LLMResponse> {
    const response = await this.client.streamCompletion(this.buildMessages());
    this.emit({
      type: "llm",
      content: response.content,
      toolCalls: response.toolCalls,
      usage: response.usage,
      timestamp: Date.now(),
    });
    return response;
  }

  private buildMessages(): ChatMessage[] {
    const messages = this.context.serializeOpenAI();
    messages[0] = {
      ...messages[0],
      content: this.buildSystemPrompt(),
    };
    return messages;
  }

  private buildSystemPrompt(): string {
    const memory = this.context.workingMemory;
    const checklist = memory.checklist
      .map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.id}`)
      .join("\n");

    return [
      "You are Reallity, a native coding agent harness.",
      "Work from the current task checklist. Use tools to inspect and modify the repository.",
      "After making code changes, run the verification gate before claiming completion.",
      "",
      `Current goal: ${memory.currentGoal || "Follow the user's request"}`,
      "",
      "Checklist:",
      checklist || "- [ ] Complete the requested task",
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

function signatureOf(diagnostic: ReturnType<typeof parseDiagnostic>): string {
  return `${diagnostic.file ?? "unknown"}:${diagnostic.line ?? "unknown"} ${diagnostic.message}`;
}

function extractPath(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as { path?: string };
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    return "";
  }
}
