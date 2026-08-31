# RealL \(Reality\) \- Native Coding Agent Harness 完整架构与规范

## 项目概述与设计哲学

**Reallity \(*****RealL***** \+ *****Reality*****\): Turn your natural language prompts into working code\.**

- **项目目标**：基于 TypeScript/Bun 构建纯原生、高可靠的本地 Coding Agent（对标 Claude Code / Aider）。

- **核心规约**：零 Agent 框架/SDK，零 API 托管沙箱；基于模型原生 Tool Calling，100% 手写 ReAct 循环、上下文管理与工具执行引擎。

- **核心哲学（Agent = LLM \+ Harness）**：抛弃裸 ReAct 架构，采用 **“FSM 强制状态管束 \+ Plan\-Execute 双层规划 \+ TDD 诊断闭环 \+ 状态快照回滚”** 治理大模型的不确定性。

    

---

## 系统模块架构与技术栈选型

|模块名称|核心技术栈|选型理由与工程价值|
|---|---|---|
|**1\. 核心状态机引擎 \(FSM Core\)**|TS \(Bun\), Hand\-written FSM|基于 TS Discriminated Unions 编写强类型状态机；实现 Plan\-Execute 规划与 ReAct 执行解耦，管束生命周期。|
|**2\. LLM 协议与 API 适配器**|Native Fetch API, Official SDKs|仅依赖官方底层 API SDK；手写带随机抖动的指数退避重试（Exponential Backoff with Jitter）；实时解析 SSE 流，透传 Token/Cache 指标。|
|**3\. 上下文与工作记忆管理器**|TS Class, In\-Memory Window|分层管理 System Prompt、结构化 Working Memory 与 Dynamic 上下文；支持动态按行读取与终端日志 Head/Tail 截断。|
|**4\. 工具注册表与安全护栏**|Zod, `pathlib`/Path, `execa`|通过 Zod 强校验参数；`edit_file` 强制 Search/Replace 唯一匹配；`Path.resolve()` 防越界；强制非交互环境变量与超时进程树销毁。|
|**5\. TDD 自愈与诊断环路**|Bun Test Runner, Diagnostic Parser|自动跑测试捕获 stderr，结构化提取“报错类型、文件名、行号、期望 vs 实际”，回灌 ReAct 循环驱动自愈。|
|**6\. 双模观察者 UI \(Telemetry\)**|Ink \(TUI\), Event Bus, Mermaid\.js|TUI 渲染流式日志与 ANSI 红绿 Diff；底层事件总线实时记录，自动导出包含 FSM DAG 图与 Cache 审计的 `trace.html` 离线追溯报告。|
|**7\. 凭据与快照回滚治理**|`@napi-rs/keyring`, Git CLI|读取系统 OS Keyring 切断硬编码；任务前自动隐式快照，连续熔断时一键执行 `git checkout .` 强制还原干净状态。|

---

## 超越 ReAct 的 FSM 状态机机制

```Plain Text
+---------+      +----------+      +-----------+      +------------+
  |  Init   | ---> |  Planner | ---> | Executor  | ---> |   Verify   |
  +---------+      +----------+      +-----------+      +------------+
                        ^                  |                  |
                        |            (Tool Call)        (Test Pass?)
                        |                  v                  |
                        |           +-----------+         YES | NO
                        +-----------| Circuit   | <-----------+  |
                         (Rollback) | Breaker   |                v
                                    +-----------+         +------------+
                                                          |  Commit    |
                                                          +------------+
```

- **显式双层循环 \(Plan\-Execute\)**：任务启动时生成 Task Checklist。`Executor` 的 ReAct 循环仅聚焦当前单个子任务，每步完成后由 Harness 强行更新 Checklist，防止上下文拉长后目标漂移。

- **强制校验门禁 \(Mandatory Verification Gate\)**：状态机硬性规定 **禁止从 ****`Tool Exec`**** 直接跳转到 ****`Finish`** 。代码修改后必须进入 `Verify` 状态跑测试，测试通过方可提交；测试失败则将结构化诊断日志回灌给模型。

- **熔断与原子回滚 \(Circuit Breaker \& Rollback\)**：

- **最大轮数保护**：单任务设置 20 轮交互上限。

- **重复报错熔断**：同类错误连续出现 3 次触发熔断。Harness 自动执行 `git checkout .` 清理受污染代码，清空混淆上下文，并强制切回 `Planner` 重新规划。

- 将 `Verify` 阶段升级为 **物理硬门禁 \+ 语义软门禁** 的双重防护：

    1. **第一阶：物理硬门禁（Deterministic Check）**

        - Harness 自动触发 `bun test` 或 Linter。

        - **结果判定**：若测试未通过，提取结构化堆栈（Diagnostic），**直接拦截并退回 ****`Executor`**** 修正，无需浪费 Token 调用 LLM Review**。

    2. **第二阶：语义软门禁（Single\-pass LLM Review）**

        - **触发条件**：仅在“单元测试通过”或“项目中没有单元测试”时触发。

        - **执行逻辑**：把 `git diff`、修改文件列表以及用户的原始需求打包，单次请求 LLM：

        > - “请作为 Code Reviewer 审查这份 Diff 是否完全符合需求，是否存在潜在 Bug 或死循环风险。返回 JSON: `{approved: bool, feedback: string}`。”
        > 
        > 

        - **状态分流**：

            - `approved: true` $\rightarrow$ 状态机切入 `Commit`。

            - `approved: false` $\rightarrow$ 将 `feedback` 装载进 Context，状态机切回 `Executor` 重新修订。

---

## 7 大核心模块职责与细节

### 核心状态机引擎 \(FSM Core\)

- **职责**：管控主循环，驱动 `Init` $\rightarrow$ `Planner` $\rightarrow$ `Executor` $\rightarrow$ `Verify` $\rightarrow$ `Commit/Rollback` 状态流转。

- **核心逻辑**：解析决策指令，触发 HITL 人工审批高危指令，实施连续 3 次同类报错熔断拦截。

    

### LLM 协议与 API 适配器 \(LLM Adapter\)

- **职责**：屏蔽底座模型差异，提供标准化的流式响应接口。

- **核心逻辑**：手写指数退避重试（$T = Base \times 2^{attempt} \times Jitter$），平滑处理 429 Rate Limit 与 5xx 抖动；流式解析 SSE 碎片，实时向上层透传 Token 消耗与 Prompt Cache 命中率。

    

### 上下文与工作记忆管理器 \(Context \& Memory Manager\)

- **职责**：精细化控制 Token 占用，维护全局状态。

- **核心逻辑**：将 System Prompt 与 Tool Schema 锁死在 Context 头部触发服务端 Prompt Caching；维护独立于对话历史的结构化 **Working Memory**（包含当前目标、任务 Checklist、已修改文件列表、已发现的项目约束）；对 Shell 输出应用 Head/Tail 截断（保留前 20 行 \+ 后 50 行）。

    

### 工具注册表与安全护栏 \(Tool Registry \& Guardrails\)

- **职责**：工具 Schema 导出、本地路由分发与确定性安全拦截。

- **核心逻辑**：通过 Zod 导出 JSON Schema 与参数反序列化；通过 `Path.resolve()` 拦截越界文件访问；正则拦截高危 Shell 命令；为子进程强制注入非交互环境变量。

    

### TDD 自愈与诊断环路 \(TDD Diagnostic Loop\)

- **职责**：作为客观反馈传感器，为 Agent 提供自愈闭环信号。

- **核心逻辑**：触发 `bun test` 或 Linter，捕获 stderr 堆栈，结构化提取“报错类型、文件名、行号、期望值 vs 实际值”，转化为结构化诊断报告送回 ReAct 循环。

    

### 观察者与可观测性引擎 \(Observer UI \& Telemetry\)

- **职责**：呈现实时运行状态并生成高维追溯报告。

- **核心逻辑**：TUI 在终端分屏渲染实时日志、`edit_file` 的 ANSI 红绿 Diff 增量高亮与 Spinner；底层抛出结构化 `AgentEvent`，任务结束时自动导出单文件 `trace.html`（内含 Mermaid\.js 渲染的 FSM 决策 DAG 图与 Token 变化趋势）。

    

### 凭据与快照回滚治理 \(Checkpoint Governance\)

- **职责**：秘钥安全与代码状态快照。

- **核心逻辑**：通过系统钥匙串存取敏感 Token；任务开始前自动记录 Git Checkpoint，当触发熔断或测试持续失败时，执行原子级代码回滚（Rollback）。

---

## 工具集规范定义 \(The Orthogonal 4\)

1. **`read_file`**：读取文件内容。支持 `start_line` / `end_line` 分页读取；强制限制在 `workspace_root` 内部。

2. **`edit_file`** **\(Search / Replace 模式\)**：接收 `path`、`old_str`、`new_str`。`old_str` 在目标文件中必须**有且仅有一次精准匹配**，否则直接拒绝并向模型抛出明确提示；仅作为文本修改，显示时渲染为 ANSI / Unified Diff。

3. **`bash`**：执行 Shell 命令。强制注入 `CI=true`、`DEBIAN_FRONTEND=noninteractive`、`PAGER=cat`、`GIT_TERMINAL_PROMPT=0`；设定 30 秒硬超时；超时自动调用 `os.killpg` 销毁整个子进程树；日志超长时自动双向截断并将 Full Log 刷盘至 `/tmp/agent_bash_latest.log`。

4. **`list_dir`** **/** **`glob`** ：遍历目录树或按通配符检索项目结构。



