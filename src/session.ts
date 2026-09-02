import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ReallityAgent,
  type AgentRunResult,
  type LLMClientLike,
} from "./agent.ts";
import {
  ContextManager,
  type OpenAIMessage,
  type WorkingMemory,
} from "./core/context.ts";
import { EventBus, type AgentEvent } from "./observer/events.ts";

export interface SessionOptions {
  workspaceRoot?: string;
  client: LLMClientLike;
  eventBus?: EventBus;
  context?: ContextManager;
  savePath?: string;
  model?: string;
  maxHistoryMessages?: number;
  maxInteractions?: number;
}

export interface SessionTaskRecord {
  index: number;
  task: string;
  answer: string;
  success: boolean;
  state: string;
  rounds: number;
  startedAt: number;
  finishedAt: number;
  eventStart: number;
  eventEnd: number;
  summary: string;
}

export interface SessionFile {
  version: 1;
  workspace: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  tasks: SessionTaskRecord[];
  context: {
    history: OpenAIMessage[];
    workingMemory: WorkingMemory;
  };
  events: AgentEvent[];
}

export interface LoadedSession {
  session: Session;
  workspace: string;
}

const sessionFileSchema = z.object({
  version: z.literal(1),
  workspace: z.string(),
  model: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  tasks: z.array(
    z.object({
      index: z.number(),
      task: z.string(),
      answer: z.string(),
      success: z.boolean(),
      state: z.string(),
      rounds: z.number(),
      startedAt: z.number(),
      finishedAt: z.number(),
      eventStart: z.number(),
      eventEnd: z.number(),
      summary: z.string(),
    }),
  ),
  context: z.object({
    history: z.array(z.any()),
    workingMemory: z.object({
      currentGoal: z.string(),
      checklist: z.array(
        z.object({
          id: z.string(),
          status: z.enum(["pending", "in_progress", "done"]),
        }),
      ),
      modifiedFiles: z.array(z.string()),
      constraints: z.array(z.string()),
      previousTasks: z.array(z.object({ task: z.string(), answer: z.string() })),
    }),
  }),
  events: z.array(z.any()),
});

export class SessionWorkspaceError extends Error {
  constructor(
    readonly sessionWorkspace: string,
    readonly currentWorkspace: string,
    reason: "mismatch" | "missing" = "mismatch",
  ) {
    super(
      reason === "missing"
        ? `Session workspace no longer exists: ${sessionWorkspace}`
        : `Session workspace mismatch: session belongs to ${sessionWorkspace}, effective workspace is ${currentWorkspace}`,
    );
    this.name = "SessionWorkspaceError";
  }
}

export class Session {
  readonly workspaceRoot: string;
  readonly context: ContextManager;
  readonly bus: EventBus;
  readonly tasks: SessionTaskRecord[] = [];
  readonly savePath?: string;
  private readonly client: LLMClientLike;
  private readonly model?: string;
  private readonly maxInteractions?: number;
  private running = false;
  private readonly createdAt: number;
  private updatedAt: number;

  constructor(options: SessionOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.client = options.client;
    this.bus = options.eventBus ?? new EventBus();
    this.context =
      options.context ??
      new ContextManager({
        systemPrompt: "",
        maxHistoryMessages: options.maxHistoryMessages ?? 120,
      });
    this.savePath = options.savePath;
    this.model = options.model;
    this.maxInteractions = options.maxInteractions;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  get busy(): boolean {
    return this.running;
  }

  async ask(task: string): Promise<AgentRunResult> {
    if (this.running) {
      throw new Error("Session is busy; wait for the current task to finish.");
    }
    this.running = true;
    const index = this.tasks.length;
    const startedAt = Date.now();
    const eventStart = this.bus.history.length;
    const modifiedBefore = this.context.workingMemory.modifiedFiles.length;
    this.context.workingMemory.previousTasks = this.tasks
      .slice(-4)
      .map((record) => ({ task: record.task, answer: record.answer }));
    this.bus.emit({
      type: "session_task_start",
      index,
      task,
      timestamp: startedAt,
    });

    let result: AgentRunResult;
    try {
      const agent = new ReallityAgent({
        workspaceRoot: this.workspaceRoot,
        client: this.client,
        eventBus: this.bus,
        context: this.context,
        maxInteractions: this.maxInteractions,
      });
      result = await agent.run(task);
    } catch (error) {
      const finishedAt = Date.now();
      this.bus.emit({
        type: "session_task_end",
        index,
        task,
        success: false,
        answer: error instanceof Error ? error.message : String(error),
        rounds: 0,
        timestamp: finishedAt,
      });
      throw error;
    } finally {
      this.running = false;
    }

    const finishedAt = Date.now();
    const modifiedCount =
      this.context.workingMemory.modifiedFiles.length - modifiedBefore;
    const record: SessionTaskRecord = {
      index,
      task,
      answer: result.answer,
      success: result.success,
      state: result.state,
      rounds: result.rounds,
      startedAt,
      finishedAt,
      eventStart,
      eventEnd: 0,
      summary: buildTaskSummary(
        index,
        task,
        result.answer,
        modifiedCount,
        result.success,
      ),
    };
    this.tasks.push(record);
    this.updatedAt = finishedAt;
    this.bus.emit({
      type: "session_task_end",
      index,
      task,
      success: result.success,
      answer: result.answer,
      rounds: result.rounds,
      timestamp: finishedAt,
    });
    record.eventEnd = this.bus.history.length;

    if (this.savePath) {
      try {
        await this.save();
      } catch (error) {
        this.bus.emit({
          type: "error",
          message: `Session save failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          timestamp: Date.now(),
        });
      }
    }
    return result;
  }

  async save(targetPath = this.savePath): Promise<void> {
    if (!targetPath) {
      throw new Error("No session save path configured");
    }
    const data: SessionFile = {
      version: 1,
      workspace: await normalizeWorkspace(this.workspaceRoot),
      model: this.model ?? "",
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      tasks: this.tasks.map((record) => ({ ...record })),
      context: this.context.toJSON(),
      events: this.bus.history,
    };
    const absolute = path.resolve(targetPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, JSON.stringify(data, null, 2), "utf8");
  }

  static async load(
    filePath: string,
    options: SessionOptions,
  ): Promise<LoadedSession> {
    let parsed: SessionFile;
    try {
      const raw = await readFile(path.resolve(filePath), "utf8");
      parsed = sessionFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `Failed to load session ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const storedWorkspace = await normalizeWorkspace(parsed.workspace);
    if (!existsSync(storedWorkspace)) {
      throw new SessionWorkspaceError(
        parsed.workspace,
        parsed.workspace,
        "missing",
      );
    }
    if (options.workspaceRoot !== undefined) {
      const effective = await normalizeWorkspace(options.workspaceRoot);
      if (effective !== storedWorkspace) {
        throw new SessionWorkspaceError(parsed.workspace, options.workspaceRoot);
      }
    }

    const bus = options.eventBus ?? new EventBus();
    bus.seed(parsed.events);
    const context = ContextManager.fromJSON(parsed.context, {
      maxHistoryMessages: options.maxHistoryMessages ?? 120,
    });
    const session = new Session({
      ...options,
      workspaceRoot: storedWorkspace,
      eventBus: bus,
      context,
      savePath: options.savePath ?? path.resolve(filePath),
    });
    session.tasks.push(...parsed.tasks);
    session.updatedAt = parsed.updatedAt;
    return { session, workspace: storedWorkspace };
  }
}

async function normalizeWorkspace(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
}

function buildTaskSummary(
  index: number,
  task: string,
  answer: string,
  modifiedCount: number,
  success: boolean,
): string {
  return `#${index + 1} ${truncateChars(task, 200)} → ${truncateChars(
    answer.trim() || "(no answer)",
    500,
  )} · 改动 ${modifiedCount} 个文件 · ${success ? "成功" : "失败"}`;
}

function truncateChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
