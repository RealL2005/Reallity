# Reallity — 原生编程智能体 Harness

Reallity 是一个手写实现的原生 coding-agent：不依赖任何 Agent 框架/SDK，也不使用 API 服务端托管的代码执行或文件工具。核心循环、上下文管理、工具定义与执行、模型输出解析、终止条件与错误处理全部自行实现。以下按五个重要子系统逐一说明其实现。

> 运行方式与快速使用见 `README.txt`（Git 仓库、单条命令、TUI/WebUI/Headless、AST 护栏等特性简介）。

---

## 1. 对话历史与上下文管理

**核心文件：`src/core/context.ts`、`src/session.ts`、`src/agent.ts`（`buildSystemPrompt`）**

对话由两类数据构成：

- **对话历史**：`ContextManager` 内部维护 `history: OpenAIMessage[]`（role/content/tool_calls/tool_call_id/reasoning_content），只追加不修改：
  - `appendUser` / `appendAssistant` / `appendTool` 分别写入用户、助手、工具结果；
  - 每次写入后 `truncateHistory()`：超出窗口时**丢最旧**。窗口默认 50 条；单任务 agent 用 60；会话（多轮）模式用 120。
- **工作记忆（结构化，不占对话窗口）**：`workingMemory` 保存当前目标（currentGoal）、任务清单（checklist）、已修改文件（modifiedFiles）、项目约束（constraints）、跨轮摘要（previousTasks）。系统提示词每次请求重建时把工作记忆拼进去，模型始终能“看见”结构化状态而不必从长历史里找。

**输出控制**：工具输出写入历史前做两层截断——`truncateOutput` 保留前 20 行 + 后 50 行并插入省略标记；`appendTool` 再按 `maxToolOutputChars`（默认 8000 字符）兜底截断。

**一致性保障**：`sanitizeToolHistory` 在序列化前检查每条 assistant 的 tool_calls 是否都有对应 tool 结果；若窗口截断导致结果缺失，会丢弃悬空的 tool_calls 而保留文本，避免发给模型“有调用无结果”的非法序列。

**跨轮延续（会话）**：`Session` 持有跨任务共享的同一个 `ContextManager` 与 `EventBus`。每个任务结束时把该轮结果压缩成摘要（任务文本 + 答案，截断到 200/500 字符）写入 `previousTasks`（保留最近 5 条）；下一任务的 system prompt 注入 "Previous conversation" 段。因此模型记得上一轮做了什么，但不会看到上一轮的全部工具噪音。

**序列化与恢复**：`toJSON()` / `fromJSON()` 深拷贝历史与工作记忆，供会话文件落盘与 `--session` 恢复；`resetChecklist()` 每任务清空清单但**保留** constraints 与 modifiedFiles（跨轮知识）。系统提示词（system prompt）本身不落盘，由 agent 每次按模式（planner/executor）重建。

**会话持久化**：`Session.save()` 把 version/workspace/model/tasks/context/events 完整写入 JSON（事件完整保留，可重建 trace）；`load()` 做 zod 校验与工作区身份校验，恢复后对话可继续。

---

## 2. 工具的定义与本地执行

**核心文件：`src/tools/schemas.ts`、`src/tools/registry.ts`、`src/tools/executor.ts`、`src/tools/guards.ts`、`src/guards/ast.ts`**

**定义**：工具用 zod 描述参数（`toolArgsSchemas`），并转成 JSON Schema 随请求发给模型（`TOOL_SCHEMAS`）。目前五个工具：

| 工具 | 作用 |
|---|---|
| `read_file` | 读文件，支持 start_line/end_line 分页 |
| `edit_file` | Search/Replace 替换（见护栏） |
| `bash` | 执行本地 shell 命令 |
| `list_dir` | 列目录 |
| `glob` | 通配符找文件 |

**执行全部在本地**：`executor.ts` 的 `dispatch` 按工具名路由，参数先 `JSON.parse` 再经 zod `parse` 强校验；文件读写走 node fs，命令走子进程，没有任何服务端托管。

**bash 子进程的隔离与安全**：
- `spawn("/bin/bash", ["-lc", cmd], { detached: true })`，注入非交互环境（CI=true、DEBIAN_FRONTEND、PAGER=cat、GIT_TERMINAL_PROMPT=0）；
- 默认 30 秒硬超时，超时用 `process.kill(-pid, "SIGKILL")` 销毁**整个进程树**；
- 输出截断并同步落盘 `/tmp/agent_bash_latest.log` 保留全量。

**确定性护栏（本地强制，不靠模型自觉）**：
- `assertInsideWorkspace`：文件类工具路径 `path.resolve` 后必须落在工作区内，越界直接拒绝；
- `assertUniqueMatch`：`edit_file` 的 old_str 必须**有且仅有一次**匹配，0 次或多次都拒绝并回错误信息；
- AST 语法门禁：修改 `.ts/.tsx/.js/.jsx` 前用 TypeScript `transpileModule` 做语法诊断，语法错误拒绝写入；
- `classifyHighRiskCommand`：正则拦截递归删除、`git reset --hard`、`git checkout .`、sudo、mkfs/dd、fork bomb、curl|sh 等；
- `isMutatingBashCommand`：只读任务下拦截写类命令（cat >、mkdir、git add、npm install、sed -i 等）。

---

## 3. 模型输出的解析

**核心文件：`src/llm/sse.ts`、`src/llm/client.ts`、`src/fsm/planner.ts`、`src/verify/review.ts`、`src/core/diagnostics.ts`**

**传输层**：使用 OpenAI 兼容 chat/completions 流式接口。`SSEParser` 按空行把字节流切成事件块，解析出 `data:` 负载，识别 `[DONE]`、内容增量、`reasoning_content`、工具调用增量与 usage。

**工具调用组装**：流式到达的是工具调用的增量片段，`applyToolCallDelta` 按 `index` 归并出完整的 `{ id, name, arguments }`；arguments 是字符串，后续由执行层 `JSON.parse` + zod 校验。这样多段拆分、顺序乱序都能正确拼回。

**语义文本解析（模型“软输出”转结构）**：
- 规划清单：`extractChecklist` 从 planner 文本里提取 `- [ ]` / 编号项，得到任务清单；提取为空则回落占位清单；
- 语义审查：`parseReviewResponse` 从模型散文回复里抠出首个 `{...}` JSON，取 `approved` 布尔与 `feedback` 文本；抠不到 JSON 视为“未批准”，带反馈回 executor；
- 测试诊断：`parseDiagnostic` 从 bun/jest stderr 提取文件名、行号、错误类型、期望值/实际值，结构化后回灌模型驱动修复。

**容错策略**：任何解析失败都不会让流程崩溃——解析不出清单用占位，审查解析不出按拒绝处理，工具参数解析失败返回带说明的失败结果。

---

## 4. 循环终止条件

**核心文件：`src/fsm/engine.ts`、`src/agent.ts`（主循环）**

主循环：`while (state !== "finish")`，每轮按当前状态分发；FSM 用**合法转移表**硬约束（如 executor 只能去 verify/rollback，禁止直接 finish）。终止/防失控由多层条件组成：

1. **自然收尾**：executor 某轮响应**无工具调用**（通常带最终文字）→ 进入 verify → 测试/审查通过 → commit → finish。
2. **强制检查点**：executor 每攒满 `toolRoundsBeforeVerify`（默认 6）轮带工具的执行，且相对“上次验证基线”确有**新改动**（`hasChangesSinceLastVerify`，排除任务前脏数据与已检查过的内容）→ 强制 verify。纯读/无新改动不打断。
3. **停滞检测（死循环识别）**：连续 `stagnationLimit`（默认 3）轮发出**完全相同**的动作（同名同参工具或相同空响应）→ 判定循环 → 回滚并重规划，提示换方法。
4. **熔断**：`CircuitBreaker(3)`——连续 3 个**同签名**的真实工具错误（bash 非零退出等探路失败不计入）或连续 3 次审查拒绝 → 回滚 + 重新规划。
5. **交互上限（最后兜底）**：`maxInteractions` 默认 200，按 **LLM 往返**计数（planner/executor/语义审查各算一次；一次响应里多个工具调用不单独计）——困难任务只要在推进就不会被误杀，只防检测遗漏的失控。
6. **planner 伪调用有界重试**：planner 输出含 `<tool_calls>`/XML 伪调用文本 → 追加警告并重新规划，每任务限一次，仍失败则回落占位清单。
7. **只读任务**：不强制 verify、不跑测试，语义审查批准即结束（模型无法改动文件，硬门禁无意义）。

所有配置项均可通过 `--max-interactions`、`--tool-rounds-before-verify`、`--stagnation-limit` 或对应环境变量调整。

---

## 5. 错误处理

**核心文件：`src/core/diagnostics.ts`、`src/llm/retry.ts`、`src/agent.ts`、`src/governance/checkpoint.ts`、`src/session.ts`**

**错误分类**：所有内部错误基于 `AgentError`（带 `code` 与 `recoverable` 标记），熔断专用 `CircuitBreakerError`；工具执行失败返回结构化 `ToolResult { success:false, error, code }`，其中 code（如 `BASH_TIMEOUT`、`BASH_NONZERO_EXIT`、`HIGH_RISK_COMMAND`）让上层能区分“探路失败”与“真错误”。

**网络层重试**：`retryWithBackoff` 对 LLM 请求做最多 3 次指数退避重试（带抖动）；只对可重试错误重试（HTTP 429 与 5xx、网络异常），4xx 业务错误直接抛给上层。

**运行期兜底**：`agent.run` 顶层 try/catch，任何异常都转为 `{ success:false, message, answer }` 返回而不是崩溃；`answer` 有回退链：最终总结 → 审查反馈（批准时）→ 最近工具输出 → 最近 LLM 内容 → 占位文本。

**回滚的原子性**：`GitCheckpoint` 任务开始时记录 head 与“任务前既有改动”（tracked diff + untracked 清单）；熔断/停滞触发 `rollback()` = 还原 agent 改动 + **重放任务前改动**，不会误删用户已有的未提交工作。

**会话层**：`Session.ask` 有 busy 互斥；即使 `agent.run` 异常也会发出 `session_task_end(success:false)`，避免 UI 卡在“运行中”；自动保存失败只发 `error` 事件、不中断对话。CLI 层把加载/解析失败打印成明确提示（如会话文件不存在时建议 `--session` 自动新建）。

**失败不阻塞原则**：单条命令失败、审查拒绝、模型解析失败都只是“反馈给模型或 UI 的信息”，由上面的终止条件决定是重试、回滚还是结束，不会让进程崩溃或静默吞掉。
