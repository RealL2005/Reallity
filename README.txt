Reallity：原生编程智能体 Harness

Git 仓库：https://github.com/RealL2005/Reallity

快速运行：
1. 复制 .env.example 为 .env，并填写 REALLITY_API_KEY（以及可选的 BASE_URL、MODEL、WORKSPACE、PORT）。
2. bun install
3. bun run src/cli.ts --mode tui --task "你的编程任务"

WebUI：bun run src/cli.ts --mode web --task "你的编程任务"
Headless：bun run src/cli.ts --mode headless --task "你的编程任务"

说明：本项目不依赖任何 Agent 框架/SDK，也不使用服务端托管代码执行。核心循环、上下文管理、工具定义与执行、模型输出解析、终止条件与错误处理均为手写实现。凭据只通过环境变量提供。

运行模式：
1. TUI：--mode tui，终端实时显示 FSM 状态、LLM 内容、工具调用、红绿 Diff 与 Token/Cache 指标。多轮对话：TUI 内直接输入即可继续对话，上下文自动延续；会话默认保存到 .reallity/session.json，可用 --session 恢复。
2. WebUI：--mode web，启动本地 trace 查看器，浏览器打开 http://127.0.0.1:3000 查看 FSM DAG、Token/Cache 审计、事件时间线和 Diff。
3. Headless：--mode headless，适合脚本与测试。

特色功能：
1. 手写 FSM 状态机：Init、Planner、Executor、Verify、Commit、Rollback、Finish，禁止从工具执行直接跳到完成。
2. Plan-Execute 双层规划：Planner 生成 Checklist，Executor 只处理当前子任务，避免目标漂移。
3. TDD 自愈：Verify 阶段强制运行 bun test；失败时解析文件名、行号、期望/实际值，回灌模型继续修复。
4. 熔断与回滚：同类错误连续 3 次触发熔断，自动 git checkout . 恢复干净状态并重新规划。
5. AST 护栏：edit_file 修改 .ts/.tsx/.js/.jsx 文件前用 TypeScript AST 做语法诊断，语法错误拒绝写入；同时强制 Search/Replace 唯一匹配与 workspace 路径越界拦截。
6. 工具集：read_file、edit_file、bash、list_dir、glob。bash 注入非交互环境变量，30 秒超时并销毁进程树。
7. 可观测性：EventBus 实时记录结构化事件，任务结束生成 trace.html，内含 Mermaid FSM 决策 DAG、Token/Cache 趋势与 Diff 审计。
