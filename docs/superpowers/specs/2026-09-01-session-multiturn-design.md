# Reallity 会话（Session）与多轮对话设计

> 日期：2026-09-01
> 状态：待评审
> 范围：TUI 多轮对话 + 会话历史持久化 + 输入区修复

## 1. 背景与目标

当前 Reallity 是单任务 harness：每次 CLI 调用（或 TUI 里 `/task`）都会新建一个 `ReallityAgent`，上下文（`ContextManager`）和事件总线（`EventBus`）全部重置，前一轮对话模型完全不可见。

另外 TUI 的 "INTERACTIVE COMMAND INPUT" 面板存在确定性缺陷：`commandHeight = 3`，但带边框的 `Panel` 组件光边框（上下各 1 行）+ 标题（1 行）就已占满 3 行，内容行（提示符 + 输入文本 + 光标）被 `overflowY: "hidden"` 裁剪，任何终端尺寸下都不可见。右侧列固定高度合计 23 行，超过 `innerHeight` 22 行，在 24 行终端上整个面板溢出到底部。当前输入框既不是对话框，也没有可见的输入位置。

目标：

1. TUI 支持多轮对话：普通文本回车即向 agent 发起新一轮任务，且 agent 能感知上一轮的任务摘要。
2. 会话历史完整持久化：上下文、working memory、全部结构化事件、任务记录落盘，支持 `--session <path>` 恢复后继续对话，并可从会话文件重新生成 trace。
3. 修复输入区：输入栏在任何终端尺寸下都可见、可用，成为真正的对话输入框。

## 2. 范围与非目标

### 范围内

- `src/session.ts`：新增会话层（Session 类 + 持久化）。
- `src/core/context.ts`：序列化/恢复、每任务 checklist 重置、跨轮任务摘要注入。
- `src/agent.ts`：可注入共享 context；每任务状态清零；system prompt 增加 Previous conversation 段。
- `src/observer/events.ts`：事件种子恢复 + 会话边界事件。
- `src/cli.ts`：TUI 允许无 `--task` 启动；`--session` / `--save-session` 参数。
- `src/observer/tui.tsx`：输入栏重构（始终可见的底栏）、自适应布局、斜杠命令、忙碌串行、每任务视图重置、对话历史面板。
- `.gitignore`、`README.txt` 收尾。

### 非目标（明确不做）

- 不做 FSM 会话级状态：`finish` 仍是任务的终点，会话续接发生在 FSM 之外。
- 不做中断任务的断点续跑：崩溃最多丢失当前任务，恢复从最近一次任务结束点继续。
- 不做 LLM 滚动摘要压缩：v1 只做任务级摘要，历史窗口从 60 放宽到 120。
- 多轮对话只在 TUI；headless / web 维持单任务语义不变。
- 会话文件不落任何 API key / 凭据。

## 3. 总体架构：两级记忆 + 会话层

生命周期分为两层：

```
会话层（跨轮，Session 持有）：
  idle → running → idle → running → ...

任务 FSM（每轮，ReallityAgent 新建）：
  init → planner → executor → verify → commit → finish
```

记忆分两级：

- **完整层（落盘）**：`ContextManager` 的 history + working memory、`EventBus` 全部事件、任务记录（含事件区间）。任务结束即自动保存，用于恢复与 trace 重建。
- **模型层（每轮注入）**：模型只看到当前任务的完整历史 + 最近 5 条任务摘要（task + 最终答案 + 改动文件数）。前几轮的工具调用细节不喂给模型，由摘要承载连续性。

`Session` 是唯一会话所有者：

```ts
class Session {
  readonly context: ContextManager;   // 跨轮共享
  readonly bus: EventBus;             // 跨轮共享
  readonly tasks: SessionTaskRecord[]; // 会话元数据

  get busy(): boolean;
  async ask(task: string): Promise<AgentRunResult>;  // 内部 new ReallityAgent({ context, eventBus })，每轮新 FSM
  async save(path?: string): Promise<void>;
  static async load(path: string, options: SessionOptions): Promise<Session>;
}
```

`Session.ask` 流程：

1. 若 `busy`，直接抛错（防御性；TUI 侧用忙碌标志阻止）。
2. 记录 `eventStart = bus.history.length`，发射 `session_task_start` 事件。
3. 更新 `context.workingMemory.previousTasks`（由历史任务生成摘要，最多 5 条）。
4. `new ReallityAgent({ workspaceRoot, client, eventBus: bus, context })` 并 `run(task)`。
5. 发射 `session_task_end` 事件，记录 `SessionTaskRecord`（含 `eventStart` / `eventEnd`）。
6. 自动保存（若配置了 savePath）。

**工作区固定**：`workspaceRoot` 在 Session 创建时确定并全程不变（`ask` 与 TUI `/run` 共用同一根目录），会话内不存在目录漂移。工作区是会话身份的一部分，恢复时校验规则见 5.3 / 5.5。

## 4. 数据模型

### 4.1 会话文件（`*.session.json`）

```json
{
  "version": 1,
  "workspace": "/abs/path",
  "model": "gpt-4.1-mini",
  "createdAt": 1756800000000,
  "updatedAt": 1756803600000,
  "tasks": [
    {
      "index": 0,
      "task": "初始化项目",
      "answer": "已创建 package.json …",
      "success": true,
      "state": "finish",
      "rounds": 5,
      "startedAt": 1756800000000,
      "finishedAt": 1756800200000,
      "eventStart": 0,
      "eventEnd": 42,
      "summary": "#1 初始化项目 → 已创建 package.json …"
    }
  ],
  "context": {
    "history": [ { "role": "user", "content": "…" } ],
    "workingMemory": {
      "currentGoal": "",
      "checklist": [],
      "modifiedFiles": ["src/session.ts"],
      "constraints": [],
      "previousTasks": []
    }
  },
  "events": [ { "type": "state", "state": "init", "timestamp": 1756800000000 } ]
}
```

约束：

- 用 zod 定义并校验，加载失败给出清晰错误并以非零码退出。
- `events` 是完整事件数组（含 `session_task_start/end`），据此可重建任意任务区间与 trace。
- `version` 预留迁移。
- 不包含 `apiKey` / `baseURL` / 任何密钥。
- `workspace` 保存为 realpath 规范化的绝对路径，是会话身份属性；恢复时必须一致（见 5.3）。

### 4.2 ContextManager 序列化

- `toJSON(): { history: OpenAIMessage[]; workingMemory: WorkingMemory }`：深拷贝输出。
- `static fromJSON(data): ContextManager`：校验形状后恢复；恢复时不触发 sanitize，`serializeOpenAI()` 仍会在使用时兜底。
- `resetChecklist()`：清空 checklist，**保留** constraints 与 modifiedFiles（跨轮知识）。
- `WorkingMemory` 增加 `previousTasks: Array<{ task: string; answer: string }>`，随 working memory 一起序列化，由 Session 维护、agent 渲染。

### 4.3 事件扩展（`src/observer/events.ts`）

新增两种会话边界事件，TUI 据此做每任务切片与视图重置，同时为 trace 提供任务分界：

```ts
| { type: "session_task_start"; index: number; task: string; timestamp: number }
| { type: "session_task_end"; index: number; task: string; success: boolean; answer: string; rounds: number; timestamp: number }
```

`EventBus` 构造器接受可选 `initialEvents`（静默种子，不触发监听器），用于 `Session.load` 恢复。

## 5. 模块改动

### 5.1 `src/core/context.ts`

- 新增 `toJSON` / `fromJSON`（或 `restore`）。
- 新增 `resetChecklist()`。
- `WorkingMemory` 增加 `previousTasks`（默认 `[]`）。
- `maxHistoryMessages` 默认值保持 60（向后兼容）；Session 创建 context 时显式传 120。

### 5.2 `src/agent.ts`

- `ReallityAgentOptions` 增加可选 `context?: ContextManager`；未传时内部新建（兼容现有测试）。
- `run()` 开头调用 `this.context.resetChecklist()`，保证每任务清单干净。
- 将 `finalAnswer` / `lastLlmContent` / `toolChainSummary` / `lastToolOutput` / `toolRounds` / `readOnly` 的初始化移入 `run()`，避免实例复用（或未来复用）时串状态。
- `buildSystemPrompt` 增加 "Previous conversation" 段，渲染 `workingMemory.previousTasks`（每条一行，task → answer 截断 500 字符）。

### 5.3 `src/session.ts`（新增）

```ts
export interface SessionOptions {
  workspaceRoot: string;
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
```

- `ask(task)`：见第 3 节流程；`busy` 由内部 `running` 标志控制。
- `save(path = this.savePath)`：序列化 `{version, workspace, model, createdAt, updatedAt, tasks, context, events}`；保存失败记录到 EventBus（`error` 事件）而不崩溃。
- `load(path, options)`：读取 + zod 校验；`EventBus` 用 `initialEvents` 种子；`ContextManager` 用 `fromJSON` 恢复；`tasks` 恢复；返回 `{ session, workspace }`（或暴露 `resolvedWorkspace`）供 CLI 校验与展示。
- 工作区校验（恢复的核心规则）：`options.workspaceRoot` 显式传入时必须与会话记录一致（realpath 比较），否则抛错；未传入时以记录为准。记录目录已不存在时报明确错误。
- 摘要生成：`#N <task> → <answer 截断 500 字符> · 改动 <n> 个文件 · 成功/失败`。

### 5.4 `src/observer/events.ts`

- 构造器增加 `initialEvents?: AgentEvent[]`（静默种子）。
- `AgentEvent` 联合类型增加会话事件（见 4.3）。

### 5.5 `src/cli.ts`

- 仅 TUI 模式允许 `--task` 为空：无任务时直接进入空闲态（聚焦输入栏），有任务时 `session.ask(task)` 自动开跑。
- headless / web 保持必填 `--task`（现有校验保留）。
- 工作区解析：当前 `--workspace` 默认取启动时 cwd。新增规则——`--session` 恢复时，生效工作区以会话记录为准：
  - 显式传入 `--workspace` 或 `REALLITY_WORKSPACE` 且与记录不一致 → 报错退出，提示“会话属于 <A>，当前生效目录为 <B>”。
  - 未显式传入 → 使用记录中的工作区，并在启动信息中显示 "Resuming session for workspace <path>"。
- 会话文件路径（TUI 默认开启自动保存，保证可恢复）：
  - 默认 `<workspace>/.reallity/session.json`（目录自动创建）。
  - `--session <path>`：加载该文件并写回；`--save-session <path>`：仅覆盖保存路径；`REALLITY_SESSION`：环境变量默认路径；`--no-session`：关闭自动保存（多轮仍在内存中进行，仅不落盘）。
  - 若 `--session` 与 `--save-session` 同传：`--session` 负责加载，`--save-session` 覆盖保存路径。
  - 相对路径按启动时 cwd 解析。
- 已知限制：同一工作区并发运行多个 TUI 会争用默认会话文件，应显式 `--save-session` 隔离。
- TUI 分支统一走 `Session`；`onTask` 回调改为 `session.ask`。
- SIGINT / SIGTERM 退出前尝试 `session.save()`（尽力而为，不阻塞退出）。

### 5.6 `src/observer/tui.tsx`

#### 输入栏（最高优先级）

- 底部**全宽单行输入栏**，不用带边框的 `Panel`：`> ` + 已输入文本 + 光标块；右侧同行显示按键提示。
- 空闲态：`[Enter] 发送 · /help 查看命令 · [Tab] 切换面板`。
- 忙碌态：显示 `⏳ agent 运行中…`，回车被忽略（提示已给出）。
- 输入语义反转：普通文本 = 对话轮（`onAsk(text)`）；斜杠命令走 `parseCommand`。

#### 斜杠命令

| 命令 | 行为 |
|---|---|
| `/task <文本>` | 显式新任务（与普通输入等价，兼容旧用法） |
| `/run <cmd>` / `/bash <cmd>` | 执行 shell 命令（原默认行为改为显式） |
| `/help` | 显示命令列表 |
| `/save [路径]` | 立即保存会话；无参数时保存到 savePath，未配置则提示 |
| `/clear` | 重置当前任务视图（diffs / workflow / LLM / summary），不清会话历史 |
| 其他 `/xxx` | 提示未知命令，不发送 |

`parseCommand(text)` 抽成纯函数（可单测），返回 `{ type: "ask" | "run" | "help" | "save" | "clear" | "unknown", ... }`。

#### 自适应布局

- 先预留固定行：输入栏 1 行 + 底部提示 1 行 + banner（≥30 行终端 5 行 figlet；小终端降为 1 行文本）。
- 剩余高度按优先级压缩：FSM TOPOLOGY → CONVERSATION → FINAL SUMMARY → workflow/diff（flex 平分剩余，最小 5 行）。
- 目标：任何终端高度下输入栏与提示行都位于屏内（80×24 渲染测试兜底）。

#### 每任务视图重置 + 会话可见性

- 监听 `session_task_start`：清空 workflow 状态日志、diffs、LLM 面板、summary，重置滚动偏移；token 面板显示“本次 / 累计”两行（本次从最近一次 `session_task_start` 起累加）。
- 监听 `session_task_end`：恢复空闲态，summary 显示最终答案。
- LLM CONTEXT 面板增加 workspace 一行（恢复会话时高亮显示生效目录，避免误操作）。
- 新增 **CONVERSATION 面板**（左列）：按序渲染 `You: <task>` / `Agent: <answer 截断>`，从 EventBus 中的会话事件实时构建；挂载时重放 `bus.history` 初始化。
- `onTask` prop 改为 `onAsk(text: string)`；`startTUI` 选项相应调整。

## 6. 错误处理

- Session 保存失败：发 `error` 事件并在输入栏提示，不中断对话。
- Session 加载失败（文件不存在 / JSON 非法 / zod 校验失败）：打印明确错误，退出码 1。
- 工作区不匹配：打印“会话属于 <A>，当前生效目录为 <B>”，退出码 1。
- 会话记录的工作区目录已不存在：打印明确错误，退出码 1。
- 忙碌时调用 `ask`：Session 抛错 + TUI 忽略回车（双保险）。
- 未知斜杠命令：提示，不发送。
- `agent.run` 失败：现有行为不变（返回 `success: false`），`session_task_end` 照常发射，`tasks` 记录失败状态。

## 7. 测试计划

### `tests/core/context.test.ts`

- `toJSON` / `fromJSON` 往返一致（history、workingMemory、previousTasks）。
- `resetChecklist()` 清空 checklist、保留 constraints / modifiedFiles。

### `tests/observer/events.test.ts`（新增）

- `initialEvents` 静默种子；会话事件类型可被订阅接收。

### `tests/agent.test.ts`

- 注入共享 context 后：第二次 `run` 能看到第一次的历史（含 previousTasks 提示）；checklist 每任务重置；FSM/轮数不串。
- 不注入 context 时行为与现状一致（向后兼容）。

### `tests/session.test.ts`（新增）

- 两次 `ask` 共享历史；第二个任务 system prompt 含上一任务摘要。
- `busy` 时 `ask` 抛错。
- `save` / `load` 往返：context、events、tasks 完整恢复；load 后 `ask` 正常续聊。
- 工作区校验：load 时显式传入不同 workspaceRoot 抛错；未传入时采用记录工作区；记录目录不存在报错。
- 配置 savePath 时任务结束后自动保存；保存失败不崩溃。
- 会话事件 `eventStart` / `eventEnd` 区间正确。

### `tests/cli.test.ts`

- TUI 无 `--task` 合法；headless/web 缺 `--task` 仍报错。
- `--session` / `--save-session` 解析与 env 默认值。
- `--session` + 不一致的 `--workspace` 报错退出。

### `tests/observer/tui.test.ts`

- `parseCommand` 各分支（普通文本、`/task`、`/run`、`/help`、`/save`、`/clear`、未知斜杠）。
- 80×24 固定终端渲染：输入提示行与内容行可见（回归测试：防止面板标题在、内容被裁）。
- 忙碌状态下回车不触发 `onAsk`。

## 8. 实施顺序

1. `ContextManager` 序列化 / `resetChecklist` / `previousTasks` + 测试
2. `EventBus` 种子 + 会话事件 + 测试
3. `ReallityAgent` 注入 context + 每任务清零 + checklist 重置 + Previous conversation 提示 + 测试
4. `Session` 类 + 持久化 + 测试
5. `cli.ts` 参数与 TUI 无任务启动 + 测试
6. `tui.tsx` 输入栏重构 / 自适应布局 / `parseCommand` / 忙碌串行 / 每任务视图重置 / CONVERSATION 面板 + 渲染测试
7. `.gitignore`（`.reallity/`、`*.session.json`）、`README.txt` 补充一行用法
8. 最终验证：`bun test` + `bunx tsc --noEmit`

## 9. 兼容性说明

- 未注入 context 时 `ReallityAgent` 行为不变，现有测试不动。
- 会话事件加入 `AgentEvent` 联合类型是纯增量，trace 渲染对未知类型已有兜底（`summarize` 需补两个 case）。
- trace.html 仍是每任务末尾由 agent 覆盖写入；`events` 已含全部会话事件，后续可从会话文件重建完整 trace（本期不做导出命令，仅保证数据完整）。
- `parseTaskCommand` 被 `parseCommand` 取代，TUI 内无其他调用方。
- 恢复要求工作区一致（realpath 比较）是新增功能的显式约束，不影响现有单任务流程。
