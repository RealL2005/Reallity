# Reallity 会话（Session）与多轮对话实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TUI 增加多轮对话与会话持久化：共享上下文、任务级摘要注入、完整事件落盘、可恢复续聊，并修复输入栏不可见问题。

**Architecture:** 会话层（Session）持有跨轮共享的 ContextManager 与 EventBus，每轮任务新建 ReallityAgent（新 FSM），通过会话边界事件驱动 TUI 视图重置。记忆分两级：完整事件落盘（`.reallity/session.json`），模型只看到当前任务历史 + 最近 5 条任务摘要。工作区是会话身份属性，恢复时校验。

**Tech Stack:** TypeScript、Bun（`./node_modules/.bin/bun`）、zod、Ink（TUI）。

**Spec:** `docs/superpowers/specs/2026-09-01-session-multiturn-design.md`

## Global Constraints

- 运行命令都在仓库根目录：`/home/jiayu-liu/CodingAgent/Reallity`。
- Bun 不在 PATH，测试与类型检查一律用 `./node_modules/.bin/bun test` 和 `./node_modules/.bin/bunx tsc --noEmit`。
- 本环境沙箱禁止监听端口，`tests/web/server.test.ts` 的 listen 测试会失败（EPERM）——属环境限制，不属于本计划的回归；其余测试必须全绿。
- 不允许使用 Agent 框架/SDK；核心逻辑全部手写。
- API key 只通过环境变量提供，会话文件绝不写入密钥。
- 每任务 TDD：先写失败测试 → 运行确认失败 → 最小实现 → 运行确认通过 → commit。
- 现有 FSM 语义不变：`finish` 是任务终点；20 轮上限、3 次同类错误熔断保持不变。
- 工作区规则：保存时用 realpath 规范化；恢复时显式传入不一致则报错，未显式传入则以会话记录为准。
- 每步 commit 使用英文 message，遵循 `feat:`/`fix:`/`test:`/`refactor:` 前缀。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/core/context.ts` | 上下文序列化、checklist 重置、previousTasks | 修改 |
| `src/observer/events.ts` | 事件种子、会话边界事件、notice 事件 | 修改 |
| `src/observer/trace.ts` | 新事件类型的 trace 渲染 | 修改 |
| `src/agent.ts` | 注入 context、每任务清零、Previous conversation 提示 | 修改 |
| `src/session.ts` | 会话层：ask/save/load/工作区校验 | 新建 |
| `src/cli.ts` | session 参数、TUI 无任务启动、TUI 接线 | 修改 |
| `src/observer/tui.tsx` | 输入栏、自适应布局、parseCommand、忙碌、会话面板 | 修改 |
| `tests/*` | 各模块 TDD 测试 | 修改/新建 |
| `.gitignore`、`README.txt` | 收尾 | 修改 |

---

### Task 1: ContextManager 序列化与 checklist 重置

**Files:**
- Modify: `src/core/context.ts`
- Test: `tests/core/context.test.ts`

**Interfaces:**
- Produces: `WorkingMemory.previousTasks: Array<{ task: string; answer: string }>`、`ContextManager.toJSON()`、`ContextManager.fromJSON(data, options?)`、`ContextManager.resetChecklist()`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/core/context.test.ts`）

```ts
test("toJSON/fromJSON round-trips history and working memory", () => {
  const manager = new ContextManager({ systemPrompt: "sys" });
  manager.appendUser("hello");
  manager.addConstraint("keep me");
  manager.addModifiedFile("src/a.ts");
  manager.addChecklistItems(["step one", "step two"]);
  manager.workingMemory.previousTasks = [{ task: "first", answer: "done" }];

  const json = manager.toJSON();
  const restored = ContextManager.fromJSON(json);

  expect(restored.serializeOpenAI()).toEqual(manager.serializeOpenAI());
  expect(restored.workingMemory).toEqual(manager.workingMemory);
});

test("resetChecklist clears items but keeps constraints and modified files", () => {
  const manager = new ContextManager({ systemPrompt: "sys" });
  manager.addChecklistItems(["step one"]);
  manager.addConstraint("no network");
  manager.addModifiedFile("src/a.ts");

  manager.resetChecklist();

  expect(manager.workingMemory.checklist).toEqual([]);
  expect(manager.workingMemory.constraints).toEqual(["no network"]);
  expect(manager.workingMemory.modifiedFiles).toEqual(["src/a.ts"]);
});

test("working memory starts with empty previousTasks", () => {
  expect(createInitialWorkingMemory().previousTasks).toEqual([]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `./node_modules/.bin/bun test tests/core/context.test.ts`
Expected: FAIL —— `toJSON is not a function` / `resetChecklist is not a function` / `previousTasks` 为 undefined。

- [ ] **Step 3: 最小实现**（修改 `src/core/context.ts`）

```ts
export interface WorkingMemory {
  currentGoal: string;
  checklist: ChecklistItem[];
  modifiedFiles: string[];
  constraints: string[];
  previousTasks: Array<{ task: string; answer: string }>;
}
```

`createInitialWorkingMemory()` 的返回值增加 `previousTasks: []`。

在 `ContextManager` 类内新增：

```ts
toJSON(): { history: OpenAIMessage[]; workingMemory: WorkingMemory } {
  return {
    history: this.history.map((message) => ({
      ...message,
      ...(message.tool_calls
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              ...call,
              function: { ...call.function },
            })),
          }
        : {}),
    })),
    workingMemory: {
      currentGoal: this.workingMemory.currentGoal,
      checklist: this.workingMemory.checklist.map((item) => ({ ...item })),
      modifiedFiles: [...this.workingMemory.modifiedFiles],
      constraints: [...this.workingMemory.constraints],
      previousTasks: this.workingMemory.previousTasks.map((entry) => ({
        ...entry,
      })),
    },
  };
}

static fromJSON(
  data: { history: OpenAIMessage[]; workingMemory: WorkingMemory },
  options: { maxHistoryMessages?: number } = {},
): ContextManager {
  const manager = new ContextManager({
    systemPrompt: "",
    workingMemory: data.workingMemory,
    maxHistoryMessages: options.maxHistoryMessages,
  });
  manager.history = data.history.map((message) => ({ ...message }));
  return manager;
}

resetChecklist(): void {
  this.workingMemory.checklist = [];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `./node_modules/.bin/bun test tests/core/context.test.ts`
Expected: PASS（含已有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/core/context.ts tests/core/context.test.ts
git commit -m "feat: add context serialization and checklist reset"
```

---

### Task 2: EventBus 种子与会话/notice 事件

**Files:**
- Modify: `src/observer/events.ts`、`src/observer/trace.ts`
- Create: `tests/observer/events.test.ts`
- Modify: `tests/observer/trace.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ContextManager`（本任务不依赖）。
- Produces: `AgentEvent` 增加 `session_task_start` / `session_task_end` / `notice`；`new EventBus({ initialEvents })` 静默种子。

- [ ] **Step 1: 写失败测试**（新建 `tests/observer/events.test.ts`）

```ts
import { test, expect } from "bun:test";
import { EventBus, type AgentEvent } from "../../src/observer/events.ts";

test("EventBus seeds initial events without notifying listeners", () => {
  const initial: AgentEvent[] = [
    { type: "state", state: "planner", timestamp: 1 },
    { type: "session_task_start", index: 0, task: "first", timestamp: 2 },
  ];
  const bus = new EventBus({ initialEvents: initial });
  const received: AgentEvent[] = [];
  bus.subscribe((event) => received.push(event));
  bus.emit({ type: "state", state: "executor", timestamp: 3 });

  expect(bus.history).toHaveLength(3);
  expect(received).toHaveLength(1);
});

test("session and notice events are emitted and stored", () => {
  const bus = new EventBus();
  bus.emit({ type: "session_task_start", index: 0, task: "hello", timestamp: 1 });
  bus.emit({ type: "notice", message: "saved", timestamp: 2 });
  bus.emit({
    type: "session_task_end",
    index: 0,
    task: "hello",
    success: true,
    answer: "done",
    rounds: 3,
    timestamp: 3,
  });

  expect(bus.history.map((event) => event.type)).toEqual([
    "session_task_start",
    "notice",
    "session_task_end",
  ]);
});
```

并追加到 `tests/observer/trace.test.ts`：

```ts
test("buildTraceHtml renders session and notice events", () => {
  const html = buildTraceHtml([
    { type: "session_task_start", index: 0, task: "init project", timestamp: 1 },
    {
      type: "session_task_end",
      index: 0,
      task: "init project",
      success: true,
      answer: "done",
      rounds: 2,
      timestamp: 2,
    },
    { type: "notice", message: "saved to .reallity/session.json", timestamp: 3 },
  ]);

  expect(html).toContain("task #0: init project");
  expect(html).toContain("task #0 success=true");
  expect(html).toContain("saved to");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `./node_modules/.bin/bun test tests/observer/events.test.ts tests/observer/trace.test.ts`
Expected: FAIL（事件类型不存在 / 构造器不接受参数）。

- [ ] **Step 3: 最小实现**

`src/observer/events.ts` 的 `AgentEvent` 联合类型追加：

```ts
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
  | { type: "notice"; message: string; timestamp: number };
```

`EventBus` 构造器改为：

```ts
export class EventBus {
  private listeners = new Set<EventListener>();
  private events: AgentEvent[];

  constructor(options: { initialEvents?: AgentEvent[] } = {}) {
    this.events = [...(options.initialEvents ?? [])];
  }
  // emit / subscribe / history 保持不变
```

`src/observer/trace.ts` 的 `summarize()` switch 追加三个 case：

```ts
    case "session_task_start":
      return `task #${event.index}: ${escapeHtml(event.task)}`;
    case "session_task_end":
      return `task #${event.index} success=${event.success}: ${escapeHtml(event.answer)}`;
    case "notice":
      return escapeHtml(event.message);
```

- [ ] **Step 4: 运行确认通过**

Run: `./node_modules/.bin/bun test tests/observer/events.test.ts tests/observer/trace.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/observer/events.ts src/observer/trace.ts tests/observer/events.test.ts tests/observer/trace.test.ts
git commit -m "feat: add session boundary and notice events"
```

---

### Task 3: ReallityAgent 注入 context 与 Previous conversation 提示

**Files:**
- Modify: `src/agent.ts`
- Test: `tests/agent.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ContextManager.resetChecklist()` 与 `workingMemory.previousTasks`。
- Produces: `ReallityAgentOptions.context?: ContextManager`；`run()` 每任务清零并重置 checklist；system prompt 渲染 Previous conversation。

- [ ] **Step 1: 写失败测试**（追加到 `tests/agent.test.ts`）

在文件顶部已有 import 基础上，追加 `ContextManager` import，并新增录制客户端与两个测试：

```ts
import { ContextManager } from "../src/core/context.ts";

class RecordingClient extends ScriptedClient {
  readonly seen: ChatMessage[][] = [];
  async streamCompletion(
    messages: ChatMessage[],
    options?: Record<string, unknown>,
  ): Promise<LLMResponse> {
    this.seen.push(messages);
    return super.streamCompletion(messages, options);
  }
}
```

```ts
test("injected context renders previous conversation and resets checklist per run", async () => {
  const context = new ContextManager({ systemPrompt: "" });
  const bus = new EventBus();
  const client = new RecordingClient([
    { content: "- [ ] step A", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "first done", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "- [ ] step B", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "second done", toolCalls: [], finishReason: "stop", usage: usage() },
  ]);

  const first = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus, context });
  await first.run("first task");
  expect(context.workingMemory.checklist.map((item) => item.id)).toEqual(["step A"]);

  context.workingMemory.previousTasks = [{ task: "first task", answer: "first done" }];
  const second = new ReallityAgent({ workspaceRoot: root, client, eventBus: bus, context });
  const result = await second.run("second task");

  expect(result.success).toBe(true);
  const plannerSystem = client.seen[2][0].content;
  expect(plannerSystem).toContain("Previous conversation");
  expect(plannerSystem).toContain("first task");
  expect(plannerSystem).not.toContain("step A");
  expect(context.workingMemory.checklist.map((item) => item.id)).toEqual(["step B"]);
});

test("answers do not leak across agent instances sharing a context", async () => {
  const context = new ContextManager({ systemPrompt: "" });
  const client = new RecordingClient([
    { content: "- [ ] step A", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "first answer", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "- [ ] step B", toolCalls: [], finishReason: "stop", usage: usage() },
    { content: "second answer", toolCalls: [], finishReason: "stop", usage: usage() },
  ]);

  const first = new ReallityAgent({ workspaceRoot: root, client, context });
  const firstResult = await first.run("first");
  const second = new ReallityAgent({ workspaceRoot: root, client, context });
  const secondResult = await second.run("second");

  expect(firstResult.answer).toBe("first answer");
  expect(secondResult.answer).toBe("second answer");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `./node_modules/.bin/bun test tests/agent.test.ts`
Expected: FAIL（`context` 选项被忽略：第二次 run 的 system prompt 不含 Previous conversation；或 checklist 残留）。

- [ ] **Step 3: 最小实现**（修改 `src/agent.ts`）

`ReallityAgentOptions` 增加字段：

```ts
  context?: ContextManager;
```

构造器中替换：

```ts
    this.context =
      options.context ??
      new ContextManager({
        systemPrompt: "",
        maxHistoryMessages: 60,
      });
```

`run()` 开头（`this.readOnly = ...` 处）改为集中清零：

```ts
    this.finalAnswer = "";
    this.lastLlmContent = "";
    this.toolChainSummary = "";
    this.lastToolOutput = "";
    this.toolRounds = 0;
    this.readOnly = looksLikeReadOnlyTask(task);
    this.context.resetChecklist();
```

`buildSystemPrompt()` 中 `const memory = this.context.workingMemory;` 之后新增：

```ts
    const previousTasks = memory.previousTasks
      .map(
        (entry) =>
          `- ${truncateChars(entry.task, 200)} → ${truncateChars(entry.answer, 500)}`,
      )
      .join("\n");
```

模板中 "Checklist:" 段之后、"Modified files:" 之前插入：

```ts
      previousTasks ? `Previous conversation:\n${previousTasks}` : "",
```

文件底部新增辅助函数：

```ts
function truncateChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `./node_modules/.bin/bun test tests/agent.test.ts`
Expected: PASS（含已有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "feat: support injected context and previous conversation prompt"
```

---

### Task 4: Session 会话层与持久化

**Files:**
- Create: `src/session.ts`
- Create: `tests/session.test.ts`

**Interfaces:**
- Consumes: Task 1（`ContextManager.toJSON/fromJSON/resetChecklist`）、Task 2（`EventBus({initialEvents})`、会话事件）、Task 3（`ReallityAgent` 注入 context）。
- Produces: `Session`（`ask/save/load/busy/tasks/savePath/workspaceRoot/context/bus`）、`SessionTaskRecord`、`LoadedSession`、`SessionWorkspaceError`。

- [ ] **Step 1: 写失败测试**（新建 `tests/session.test.ts`，完整内容）

```ts
import { test, expect, beforeEach } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Session } from "../src/session.ts";
import { EventBus } from "../src/observer/events.ts";
import type { ChatMessage, LLMResponse } from "../src/llm/types.ts";

const execFileAsync = promisify(execFile);

function usage() {
  return {
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 1,
  };
}

class FakeClient {
  readonly seen: ChatMessage[][] = [];
  private calls = 0;
  constructor(private readonly answers: string[]) {}

  async streamCompletion(messages: ChatMessage[]): Promise<LLMResponse> {
    this.seen.push(messages);
    const content = this.answers[this.calls] ?? "done";
    this.calls += 1;
    return {
      content,
      reasoningContent: "",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(),
    };
  }
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "reallity-session-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agent@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agent"], { cwd: root });
  await writeFile(path.join(root, "file.txt"), "hello\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
});

test("ask runs a task and records session metadata and events", async () => {
  const bus = new EventBus();
  const session = new Session({ workspaceRoot: root, client: new FakeClient([]), eventBus: bus });
  const result = await session.ask("hello");

  expect(result.success).toBe(true);
  expect(session.tasks).toHaveLength(1);
  expect(session.tasks[0]).toMatchObject({ index: 0, task: "hello", success: true });
  const types = bus.history.map((event) => event.type);
  expect(types).toContain("session_task_start");
  expect(types).toContain("session_task_end");
});

test("second ask sees the previous task summary in context", async () => {
  const client = new FakeClient([
    "- [ ] step A",
    "first answer",
    "- [ ] step B",
    "second answer",
  ]);
  const session = new Session({ workspaceRoot: root, client });
  await session.ask("first task");
  await session.ask("second task");

  const secondPlannerSystem = client.seen[2][0].content;
  expect(secondPlannerSystem).toContain("Previous conversation");
  expect(secondPlannerSystem).toContain("first task");
  expect(secondPlannerSystem).toContain("first answer");
  expect(session.context.workingMemory.checklist.map((item) => item.id)).toEqual([
    "step B",
  ]);
});

test("ask throws when the session is busy", async () => {
  const session = new Session({ workspaceRoot: root, client: new FakeClient([]) });
  (session as unknown as { running: boolean }).running = true;
  await expect(session.ask("x")).rejects.toThrow(/busy/i);
});

test("save/load round-trips and continues conversation", async () => {
  const sessionPath = path.join(root, ".reallity", "session.json");
  const firstClient = new FakeClient(["- [ ] step A", "first answer"]);
  const session = new Session({ workspaceRoot: root, client: firstClient, savePath: sessionPath });
  await session.ask("first task");
  expect(existsSync(sessionPath)).toBe(true);

  const secondClient = new FakeClient(["- [ ] step B", "second answer"]);
  const loaded = await Session.load(sessionPath, { workspaceRoot: root, client: secondClient });

  expect(loaded.workspace).toBe(await realpath(root));
  expect(loaded.session.tasks).toHaveLength(1);
  expect(loaded.session.bus.history).toEqual(session.bus.history);

  const result = await loaded.session.ask("second task");
  expect(result.success).toBe(true);
  expect(loaded.session.tasks).toHaveLength(2);
  expect(secondClient.seen[0][0].content).toContain("Previous conversation");
});

test("load rejects a workspace mismatch", async () => {
  const sessionPath = path.join(root, "session.json");
  const session = new Session({ workspaceRoot: root, client: new FakeClient([]), savePath: sessionPath });
  await session.ask("hi");

  const other = await mkdtemp(path.join(tmpdir(), "reallity-other-"));
  await expect(
    Session.load(sessionPath, { workspaceRoot: other, client: new FakeClient([]) }),
  ).rejects.toThrow(/workspace/i);
});

test("load rejects when the recorded workspace no longer exists", async () => {
  const sessionPath = path.join(root, "session.json");
  const session = new Session({ workspaceRoot: root, client: new FakeClient([]), savePath: sessionPath });
  await session.ask("hi");
  await rm(root, { recursive: true, force: true });

  await expect(
    Session.load(sessionPath, { workspaceRoot: root, client: new FakeClient([]) }),
  ).rejects.toThrow(/no longer exists/i);
});

test("ask succeeds even when auto-save fails and emits an error event", async () => {
  const bus = new EventBus();
  const session = new Session({
    workspaceRoot: root,
    client: new FakeClient([]),
    eventBus: bus,
    savePath: "/proc/1/forbidden/session.json",
  });
  const result = await session.ask("hi");

  expect(result.success).toBe(true);
  expect(bus.history.some((event) => event.type === "error")).toBe(true);
});

test("task records capture event ranges", async () => {
  const session = new Session({ workspaceRoot: root, client: new FakeClient([]) });
  await session.ask("one");
  const firstEnd = session.tasks[0].eventEnd;
  await session.ask("two");

  expect(session.tasks[1].eventStart).toBe(firstEnd);
  expect(session.tasks[1].eventEnd).toBeGreaterThan(firstEnd);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `./node_modules/.bin/bun test tests/session.test.ts`
Expected: FAIL —— `Cannot find module ../src/session.ts`。

- [ ] **Step 3: 实现 `src/session.ts`**（完整文件）

```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ReallityAgent, type AgentRunResult, type LLMClientLike } from "./agent.ts";
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
    this.bus.emit({ type: "session_task_start", index, task, timestamp: startedAt });

    let result: AgentRunResult;
    try {
      const agent = new ReallityAgent({
        workspaceRoot: this.workspaceRoot,
        client: this.client,
        eventBus: this.bus,
        context: this.context,
      });
      result = await agent.run(task);
    } finally {
      this.running = false;
    }

    const finishedAt = Date.now();
    const eventEnd = this.bus.history.length;
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
      eventEnd,
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
      throw new SessionWorkspaceError(parsed.workspace, parsed.workspace, "missing");
    }
    if (options.workspaceRoot !== undefined) {
      const effective = await normalizeWorkspace(options.workspaceRoot);
      if (effective !== storedWorkspace) {
        throw new SessionWorkspaceError(parsed.workspace, options.workspaceRoot);
      }
    }

    const bus = new EventBus({ initialEvents: parsed.events });
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
```

- [ ] **Step 4: 运行确认通过**

Run: `./node_modules/.bin/bun test tests/session.test.ts`
Expected: PASS（全部 8 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "feat: add session layer with persistence and workspace identity"
```

---

### Task 5: CLI 参数与 TUI 无任务启动

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `Session` / `Session.load`。
- Produces: `CliOptions.sessionPath/saveSessionPath/noSession/workspaceExplicit`；TUI 分支走 Session；缺 `--task` 仅 headless/web 报错。

- [ ] **Step 1: 写失败测试**（追加到 `tests/cli.test.ts`）

```ts
test("parseCliArgs accepts session flags", () => {
  const parsed = parseCliArgs([
    "--session",
    "s.json",
    "--save-session",
    "t.json",
    "--no-session",
  ]);

  expect(parsed.sessionPath).toBe("s.json");
  expect(parsed.saveSessionPath).toBe("t.json");
  expect(parsed.noSession).toBe(true);
});

test("parseCliArgs marks explicit workspace only when overridden", () => {
  expect(parseCliArgs(["--workspace", "/tmp/x"]).workspaceExplicit).toBe(true);
  expect(parseCliArgs([]).workspaceExplicit).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `./node_modules/.bin/bun test tests/cli.test.ts`
Expected: FAIL（字段为 undefined / false）。

- [ ] **Step 3: 实现**

`src/cli.ts` 的 `CliOptions` 接口增加：

```ts
  sessionPath?: string;
  saveSessionPath?: string;
  noSession: boolean;
  workspaceExplicit: boolean;
```

`parseCliArgs` 默认值增加：

```ts
    noSession: false,
    workspaceExplicit: Boolean(process.env.REALLITY_WORKSPACE?.trim()),
```

switch 中增加 case：

```ts
      case "--session":
        options.sessionPath = argv[++index] ?? undefined;
        break;
      case "--save-session":
        options.saveSessionPath = argv[++index] ?? undefined;
        break;
      case "--no-session":
        options.noSession = true;
        break;
```

`--workspace` case 中追加 `options.workspaceExplicit = true;`。

缺 task 校验改为仅非 TUI 报错：

```ts
  if (!options.task && options.mode !== "tui") {
    console.error("Missing task. Pass --task \"your request\".");
    return 1;
  }
```

文件顶部 import 增加：

```ts
import { existsSync } from "node:fs";
import { Session } from "./session.ts";
```

TUI 分支整体替换为：

```ts
  if (options.mode === "tui") {
    const envSession = process.env.REALLITY_SESSION?.trim() || undefined;
    const defaultSavePath = path.join(
      path.resolve(options.workspace),
      ".reallity",
      "session.json",
    );
    const autoLoadPath =
      envSession && existsSync(envSession) ? envSession : undefined;
    const loadPath =
      options.sessionPath ?? (options.noSession ? undefined : autoLoadPath);
    const savePath = options.noSession
      ? options.saveSessionPath ?? options.sessionPath
      : options.saveSessionPath ??
        options.sessionPath ??
        envSession ??
        defaultSavePath;

    let session: Session;
    if (loadPath) {
      try {
        const loaded = await Session.load(loadPath, {
          workspaceRoot: options.workspaceExplicit
            ? options.workspace
            : undefined,
          client,
          savePath,
          model: options.model,
        });
        session = loaded.session;
      } catch (error) {
        console.error(
          `Failed to resume session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 1;
      }
    } else {
      session = new Session({
        workspaceRoot: options.workspace,
        client,
        savePath,
        model: options.model,
      });
    }

    const stopTUI = startTUI(eventBus, {
      model: options.model,
      mode: options.mode,
      task: options.task,
      tokenLimit: Number(process.env.REALLITY_TOKEN_LIMIT ?? 200_000),
      workspaceRoot: session.workspaceRoot,
      resumed: Boolean(loadPath),
      onAsk: (task) => {
        void session.ask(task);
      },
      onSave: (sessionPath) => {
        void (async () => {
          try {
            await session.save(sessionPath);
            eventBus.emit({
              type: "notice",
              message: `Session saved to ${sessionPath ?? session.savePath}`,
              timestamp: Date.now(),
            });
          } catch (error) {
            eventBus.emit({
              type: "error",
              message: `Session save failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              timestamp: Date.now(),
            });
          }
        })();
      },
    });
    if (options.task) {
      void session.ask(options.task);
    }
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    if (session.savePath) {
      try {
        await session.save();
      } catch {
        // best-effort save on exit
      }
    }
    stopTUI();
    return 0;
  }
```

> 注：TUI 分支中的 `startTUI` 参数（`resumed`/`onAsk`/`onSave`）在 Task 6/7 中实现，届时 TypeScript 才通过；本任务结束时 `bunx tsc` 会报这两个未识别选项，属预期中间态，Task 7 完成后归零。

- [ ] **Step 4: 运行确认通过**

Run: `./node_modules/.bin/bun test tests/cli.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: add session flags and taskless TUI startup"
```

---

### Task 6: TUI 输入语义：parseCommand、忙碌串行、每任务重置

**Files:**
- Modify: `src/observer/tui.tsx`
- Test: `tests/observer/tui.test.ts`

**Interfaces:**
- Consumes: Task 2 的会话事件、Task 5 的 `onAsk/onSave` props。
- Produces: `parseCommand`、`buildConversation`、`TuiApp` 导出、`onAsk/onSave/splashMs` props、`ActivityItem.kind: "notice"`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/observer/tui.test.ts`）

```ts
import { parseCommand, buildConversation } from "../../src/observer/tui.tsx";

test("parseCommand routes plain text to ask", () => {
  expect(parseCommand("fix the bug")).toEqual({ type: "ask", text: "fix the bug" });
  expect(parseCommand("/task fix the bug")).toEqual({ type: "ask", text: "fix the bug" });
  expect(parseCommand("")).toBeNull();
  expect(parseCommand("   ")).toBeNull();
});

test("parseCommand routes slash commands", () => {
  expect(parseCommand("/run ls -la")).toEqual({ type: "run", command: "ls -la" });
  expect(parseCommand("/bash pwd")).toEqual({ type: "run", command: "pwd" });
  expect(parseCommand("/help")).toEqual({ type: "help" });
  expect(parseCommand("/save")).toEqual({ type: "save", path: undefined });
  expect(parseCommand("/save /tmp/x.json")).toEqual({
    type: "save",
    path: "/tmp/x.json",
  });
  expect(parseCommand("/clear")).toEqual({ type: "clear" });
  expect(parseCommand("/bogus")).toEqual({ type: "unknown", command: "/bogus" });
});

test("buildConversation pairs task start and end events", () => {
  const events: AgentEvent[] = [
    { type: "session_task_start", index: 0, task: "first", timestamp: 1 },
    { type: "session_task_start", index: 1, task: "second", timestamp: 2 },
    {
      type: "session_task_end",
      index: 0,
      task: "first",
      success: true,
      answer: "a1",
      rounds: 2,
      timestamp: 3,
    },
    {
      type: "session_task_end",
      index: 1,
      task: "second",
      success: false,
      answer: "a2",
      rounds: 3,
      timestamp: 4,
    },
  ];

  expect(buildConversation(events)).toEqual([
    { index: 0, task: "first", answer: "a1", success: true },
    { index: 1, task: "second", answer: "a2", success: false },
  ]);
});
```

（`AgentEvent` 类型需从 `../../src/observer/events.ts` 追加 import。）

- [ ] **Step 2: 运行确认失败**

Run: `./node_modules/.bin/bun test tests/observer/tui.test.ts`
Expected: FAIL（`parseCommand`/`buildConversation` 未导出）。

- [ ] **Step 3: 实现**（修改 `src/observer/tui.tsx`）

`ActivityItem.kind` 联合类型追加 `| "notice"`；`PanelId` 移除 `"command"`；`PANEL_ORDER` 改为：

```ts
const PANEL_ORDER: PanelId[] = [
  "topology",
  "conversation",
  "workflow",
  "summary",
  "llm",
  "token",
  "diff",
];
```

新增导出纯函数（放在 `parseTaskCommand` 原位置，删除原函数）：

```ts
export type ParsedCommand =
  | { type: "ask"; text: string }
  | { type: "run"; command: string }
  | { type: "help" }
  | { type: "save"; path?: string }
  | { type: "clear" }
  | { type: "unknown"; command: string };

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/task ")) {
    const text = trimmed.slice(6).trim();
    return text ? { type: "ask", text } : { type: "unknown", command: trimmed };
  }
  if (trimmed === "/task") return { type: "unknown", command: trimmed };
  if (trimmed.startsWith("/run ")) {
    return { type: "run", command: trimmed.slice(5).trim() };
  }
  if (trimmed.startsWith("/bash ")) {
    return { type: "run", command: trimmed.slice(6).trim() };
  }
  if (trimmed === "/help") return { type: "help" };
  if (trimmed === "/clear") return { type: "clear" };
  if (trimmed === "/save") return { type: "save", path: undefined };
  if (trimmed.startsWith("/save ")) {
    return { type: "save", path: trimmed.slice(6).trim() || undefined };
  }
  if (trimmed.startsWith("/")) return { type: "unknown", command: trimmed };
  return { type: "ask", text: trimmed };
}

export interface ConversationEntry {
  index: number;
  task: string;
  answer: string;
  success: boolean;
}

export function buildConversation(events: AgentEvent[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const pending = new Map<number, { task: string; index: number }>();
  for (const event of events) {
    if (event.type === "session_task_start") {
      pending.set(event.index, { task: event.task, index: event.index });
    } else if (event.type === "session_task_end") {
      const start = pending.get(event.index);
      if (start) {
        entries.push({
          index: event.index,
          task: start.task,
          answer: event.answer,
          success: event.success,
        });
        pending.delete(event.index);
      }
    }
  }
  return entries.sort((a, b) => a.index - b.index);
}
```

`TuiAppProps` 改为：

```ts
interface TuiAppProps {
  bus: EventBus;
  model?: string;
  mode?: string;
  task?: string;
  tokenLimit?: number;
  workspaceRoot?: string;
  resumed?: boolean;
  splashMs?: number;
  onAsk?: (text: string) => void;
  onSave?: (sessionPath?: string) => void;
}
```

`function TuiApp` 改为 `export function TuiApp`，解构参数增加 `resumed = false, splashMs = 2_200, onAsk, onSave`（移除 `onTask`）。

组件内新增状态与辅助函数：

```ts
  const [currentUsage, setCurrentUsage] = useState({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
  });

  const appendActivity = (item: ActivityItem) => {
    setStateLog((current) => {
      const state = currentStateRef.current;
      return { ...current, [state]: [...current[state], item] };
    });
  };

  const resetTaskView = () => {
    setStateLog({});
    setDiffs([]);
    setSnapshot((current) => ({
      ...current,
      summary: "",
      llm: "",
      currentTool: undefined,
      toolError: undefined,
    }));
    setWorkflowOffset(0);
    setSummaryOffset(0);
    setLlmOffset(0);
    setDiffFocus(0);
    setDiffOffsets([]);
    setErrorCount(0);
    setCurrentUsage({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
    });
  };
```

初始 snapshot 的 `running` 改为 `false`；splash 定时器用 `splashMs`：

```ts
    const timer = setTimeout(() => setShowSplash(false), splashMs);
```

订阅回调中的 running 判定替换为：

```ts
          if (event.type === "session_task_start") {
            next.running = true;
          } else if (
            event.type === "session_task_end" ||
            event.type === "finish"
          ) {
            next.running = false;
          }
```

（删除原 `running: event.type !== "finish"` 行。）

在订阅回调里，`session_task_start` 分支调用 `resetTaskView()`，`llm` 分支同时累计 `currentUsage`：

```ts
        if (event.type === "session_task_start") {
          resetTaskView();
        }
        if (event.type === "llm") {
          setCurrentUsage((current) => ({
            promptTokens: current.promptTokens + event.usage.promptTokens,
            completionTokens:
              current.completionTokens + event.usage.completionTokens,
            totalTokens: current.totalTokens + event.usage.totalTokens,
            promptCacheHitTokens:
              current.promptCacheHitTokens + event.usage.promptCacheHitTokens,
            promptCacheMissTokens:
              current.promptCacheMissTokens + event.usage.promptCacheMissTokens,
          }));
        }
```

`useInput` 的 `key.return` 分支整体替换为：

```ts
    if (key.return) {
      if (command.trim()) {
        if (snapshot.running) {
          setCommand("");
          return;
        }
        const parsed = parseCommand(command);
        if (parsed) {
          switch (parsed.type) {
            case "ask":
              onAsk?.(parsed.text);
              break;
            case "run":
              void runCommand(parsed.command, workspaceRoot, appendActivity);
              break;
            case "help":
              appendActivity({
                kind: "notice",
                text: "Commands: /task <text> · /run <cmd> · /bash <cmd> · /save [path] · /clear · /help",
                color: "gray",
              });
              break;
            case "save":
              onSave?.(parsed.path);
              break;
            case "clear":
              resetTaskView();
              break;
            case "unknown":
              appendActivity({
                kind: "notice",
                text: `Unknown command: ${parsed.command} — type /help`,
                color: "gray",
              });
              break;
          }
        }
        setCommand("");
        return;
      }
      if (activePanel === "llm" && lastLlmId) {
        setExpandedLlmIds((current) => {
          const next = new Set(current);
          if (next.has(lastLlmId)) next.delete(lastLlmId);
          else next.add(lastLlmId);
          return next;
        });
      }
      setCommand("");
      return;
    }
```

字符输入分支：删除 `setActivePanel("command")`，改为：

```ts
      if (input && !key.ctrl && !key.meta) {
        setCommand(input);
        return;
      }
```

`summarizeActivity` 追加：

```ts
    case "notice":
      return { kind: "notice", text: event.message, color: "gray" };
    case "session_task_start":
    case "session_task_end":
      return null;
```

`TokenStats` 增加 `current` prop 并在第一行下方显示：

```ts
function TokenStats({
  usage,
  current,
  limit,
  errorCount,
}: {
  usage: LLMUsage;
  current: LLMUsage;
  limit: number;
  errorCount: number;
}) {
  const cost =
    (usage.promptTokens / 1_000_000) * 3 +
    (usage.completionTokens / 1_000_000) * 15;
  const remaining = Math.max(0, limit - usage.totalTokens);
  const cacheTotal =
    usage.promptCacheHitTokens + usage.promptCacheMissTokens;
  const cacheHitRate =
    cacheTotal > 0
      ? `${Math.round((usage.promptCacheHitTokens / cacheTotal) * 100)}%`
      : "n/a";
  return (
    <Box flexDirection="column">
      <Text color="white">
        prompt {usage.promptTokens} · completion {usage.completionTokens} · total{" "}
        {usage.totalTokens}
      </Text>
      <Text color="white">session {usage.totalTokens} · this task {current.totalTokens}</Text>
      <Text color="white">
        cache hit {cacheHitRate} · err signatures {errorCount}/3
      </Text>
      <Text color="yellow">est cost ${cost.toFixed(4)}</Text>
      <Text color="gray">remaining {remaining} / {limit}</Text>
    </Box>
  );
}
```

`startTUI` 选项替换 `onTask`：

```ts
export function startTUI(
  bus: EventBus,
  options: {
    model?: string;
    mode?: string;
    task?: string;
    tokenLimit?: number;
    workspaceRoot?: string;
    resumed?: boolean;
    splashMs?: number;
    onAsk?: (text: string) => void;
    onSave?: (sessionPath?: string) => void;
  } = {},
): () => void {
  const instance = render(<TuiApp bus={bus} {...options} />);
  return () => {
    instance.unmount();
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `./node_modules/.bin/bun test tests/observer/tui.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/observer/tui.tsx tests/observer/tui.test.ts
git commit -m "feat: route TUI input to conversation and slash commands"
```

---

### Task 7: TUI 自适应布局、输入栏与 CONVERSATION 面板

**Files:**
- Modify: `src/observer/tui.tsx`
- Test: `tests/observer/tui.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `parseCommand/buildConversation/onAsk/onSave`。
- Produces: `computeHeights(rows)`、全宽输入栏、CONVERSATION 面板、workspace 显示、渲染测试。

- [ ] **Step 1: 写失败测试**（追加到 `tests/observer/tui.test.ts`）

```ts
import React from "react";
import { render } from "ink";
import { TuiApp, computeHeights } from "../../src/observer/tui.tsx";

test("computeHeights keeps the input bar visible across terminal sizes", () => {
  for (const rows of [16, 24, 30, 40, 60]) {
    const h = computeHeights(rows);
    expect(h.inputHeight).toBe(1);
    expect(h.hintHeight).toBe(1);
    expect(h.bannerHeight).toBeGreaterThanOrEqual(1);
    const leftTotal =
      h.topologyHeight + h.conversationHeight + h.summaryHeight + h.workflowHeight;
    const rightTotal = h.llmHeight + h.tokenHeight + h.diffHeight;
    expect(leftTotal).toBeLessThanOrEqual(h.innerHeight);
    expect(rightTotal).toBeLessThanOrEqual(h.innerHeight);
    expect(h.workflowHeight).toBeGreaterThanOrEqual(3);
    expect(h.diffHeight).toBeGreaterThanOrEqual(3);
  }
});

class FakeStdout {
  output = "";
  columns = 80;
  rows = 24;
  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
}

test("TUI renders the conversation input bar at 80x24", async () => {
  const bus = new EventBus();
  const stdout = new FakeStdout();
  const instance = render(
    React.createElement(TuiApp, {
      bus,
      task: "",
      workspaceRoot: "/tmp",
      splashMs: 0,
    }),
    { stdout: stdout as unknown as NodeJS.WriteStream },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(stdout.output).toContain("Reallity");
  expect(stdout.output).toContain("> ");
  expect(stdout.output).not.toContain("INTERACTIVE COMMAND INPUT");

  instance.unmount();
});
```

（`EventBus` 已在顶部 import；`buildConversation` 已在 Task 6 引入。）

- [ ] **Step 2: 运行确认失败**

Run: `./node_modules/.bin/bun test tests/observer/tui.test.ts`
Expected: FAIL（`computeHeights`/`TuiApp` 未导出；`> ` 不在输出中）。

- [ ] **Step 3: 实现**（修改 `src/observer/tui.tsx`）

新增导出纯函数（放在 `TuiApp` 之前）：

```ts
export interface TuiHeights {
  bannerHeight: number;
  inputHeight: number;
  hintHeight: number;
  innerHeight: number;
  topologyHeight: number;
  conversationHeight: number;
  summaryHeight: number;
  workflowHeight: number;
  llmHeight: number;
  tokenHeight: number;
  diffHeight: number;
}

export function computeHeights(rows: number): TuiHeights {
  const terminalHeight = Math.max(16, rows - 2);
  const bannerHeight = terminalHeight >= 30 ? 5 : 1;
  const inputHeight = 1;
  const hintHeight = 1;
  const innerHeight = Math.max(
    8,
    terminalHeight - bannerHeight - inputHeight - hintHeight,
  );
  const topologyHeight = Math.max(
    3,
    Math.min(4, Math.floor(innerHeight / 6)),
  );
  const summaryHeight = Math.max(
    3,
    Math.min(6, Math.floor(innerHeight / 5)),
  );
  const conversationHeight = Math.max(
    3,
    Math.min(7, Math.floor(innerHeight / 4)),
  );
  const workflowHeight = Math.max(
    3,
    innerHeight - topologyHeight - conversationHeight - summaryHeight,
  );
  const llmHeight = Math.max(3, Math.min(4, Math.floor(innerHeight / 6)));
  const tokenHeight = Math.max(4, Math.min(6, Math.floor(innerHeight / 5)));
  const diffHeight = Math.max(3, innerHeight - llmHeight - tokenHeight);
  return {
    bannerHeight,
    inputHeight,
    hintHeight,
    innerHeight,
    topologyHeight,
    conversationHeight,
    summaryHeight,
    workflowHeight,
    llmHeight,
    tokenHeight,
    diffHeight,
  };
}
```

`TuiApp` 顶部高度常量整体替换为：

```ts
  const {
    bannerHeight,
    inputHeight,
    hintHeight,
    innerHeight,
    topologyHeight,
    conversationHeight,
    summaryHeight,
    workflowHeight,
    llmHeight,
    tokenHeight,
    diffHeight,
  } = computeHeights(stdout.rows);
```

（删除原 `terminalHeight/bannerHeight/summaryHeight/topologyHeight/innerHeight/workflowHeight/llmHeight/tokenHeight/commandHeight/diffHeight` 常量定义。）

渲染部分：

- banner 行改为条件渲染：`{bannerHeight >= 5 ? <GradientBanner text="Reallity" font="Small" /> : <Text bold color="cyan">Reallity TUI</Text>}`。
- 左列 `FSM TOPOLOGY` 之后插入 CONVERSATION 面板：

```tsx
          <Panel
            title="CONVERSATION"
            color="magenta"
            height={conversationHeight}
            width={leftWidth - 2}
            focused={activePanel === "conversation"}
          >
            <ConversationView
              entries={conversation}
              width={leftWidth - 6}
              height={conversationHeight - 3}
            />
          </Panel>
```

- 右列 `LLM CONTEXT` 面板内容增加 workspace 行：

```tsx
            <Text color="white" wrap="truncate">
              workspace: {workspaceRoot || "(default)"}
            </Text>
            {resumed ? <Text color="yellow">resumed session</Text> : null}
```

- 删除右列末尾的 `INTERACTIVE COMMAND INPUT` Panel。
- 外层结构改为：banner → 双列 Box → 输入栏 Box → 底部提示 Text，并给 `TokenStats` 传 `current={currentUsage}`：

```tsx
      <Box flexDirection="row" width={contentWidth} height={inputHeight}>
        <Text color={snapshot.running ? "yellow" : "green"}>
          {snapshot.running ? "⏳ " : "> "}
        </Text>
        <Text color="white" wrap="truncate">{command}</Text>
        <Text color="gray">{snapshot.running ? "" : "█"}</Text>
        <Text color="gray" wrap="truncate">
          {snapshot.running
            ? "agent 运行中…"
            : "[Enter] 发送 · [Tab] 面板 · /help"}
        </Text>
      </Box>
      <Text color="gray">
        [Tab] Switch Panel · [↑/↓] Workflow · [PgUp/PgDn] Summary · [Enter] Send
      </Text>
```

新增 `ConversationView` 组件（放在 `WorkflowView` 附近）：

```tsx
function ConversationView({
  entries,
  width,
  height,
}: {
  entries: ConversationEntry[];
  width: number;
  height: number;
}) {
  if (entries.length === 0) {
    return <Text color="gray">No conversation yet — type a message below.</Text>;
  }
  const lines: ColoredLine[] = entries.flatMap((entry) => [
    {
      text: `You: ${truncateText(entry.task, width)}`,
      color: "cyan",
      wrap: false,
    },
    {
      text: `Agent: ${truncateText(entry.answer, width)}`,
      color: entry.success ? "green" : "red",
      wrap: false,
    },
  ]);
  return <StringScrollable lines={lines} height={height} offset={0} width={width} />;
}
```

`TuiApp` 内新增对话派生（放在 return 之前）：

```ts
  const conversation = useMemo(
    () => buildConversation(bus.history),
    [bus, snapshot.events],
  );
```

- [ ] **Step 4: 运行确认通过**

Run: `./node_modules/.bin/bun test tests/observer/tui.test.ts`
Expected: PASS（含渲染冒烟测试与高度不变量）。

- [ ] **Step 5: 全量验证**

Run: `./node_modules/.bin/bun test` 与 `./node_modules/.bin/bunx tsc --noEmit`
Expected: 除 `tests/web/server.test.ts` 的 listen EPERM（环境限制）外全绿；tsc 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/observer/tui.tsx tests/observer/tui.test.ts
git commit -m "feat: adaptive TUI layout with always-visible input bar"
```

---

### Task 8: 收尾与文档

**Files:**
- Modify: `.gitignore`、`README.txt`

- [ ] **Step 1: 修改 `.gitignore`**（追加）

```gitignore
.reallity/
*.session.json
```

- [ ] **Step 2: 修改 `README.txt`**

在“运行模式”的 TUI 条目后追加一行（保持全文 ≤1000 汉字）：

```text
多轮对话：TUI 内直接输入即可继续对话，上下文自动延续；会话默认保存到 .reallity/session.json，可用 --session 恢复。
```

- [ ] **Step 3: 全量验证**

Run: `./node_modules/.bin/bun test` 与 `./node_modules/.bin/bunx tsc --noEmit`
Expected: 除 sandbox EPERM 的 listen 测试外全绿；tsc 无错误。

- [ ] **Step 4: Commit**

```bash
git add .gitignore README.txt
git commit -m "docs: document session resume and ignore session files"
```

---

## 自检记录

- Spec 覆盖：4.1 会话文件（Task 4）、4.2 序列化（Task 1）、4.3 事件（Task 2）、5.1 context（Task 1）、5.2 agent（Task 3）、5.3 session（Task 4）、5.4 events（Task 2）、5.5 cli 与工作区规则（Task 5）、5.6 TUI（Task 6/7）、6 错误处理（Task 4/6 内实现）、7 测试（各任务）、8 顺序、9 兼容（trace 新 case 在 Task 2）。
- 类型一致性：`parseCommand`/`ConversationEntry`/`Session`/`LoadedSession`/`TuiHeights` 在各任务中的签名一致；事件字段 `session_task_start/end` 在 Task 2/4/6 中形状相同。
- 无占位符：所有实现步骤均含可直接落盘的代码。
