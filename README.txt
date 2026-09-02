Reallity：编程 Harness

Git 仓库：https://github.com/RealL2005/Reallity

快速运行：
1. 复制 .env.example 为 .env，并填写 REALLITY_API_KEY（以及可选的 BASE_URL、MODEL、WORKSPACE、PORT）。
2. bun install
3. bun run src/cli.ts --mode tui --task "你的编程任务"
4. 也可以直接输入reallity
5. Ctrl-C退出

工作目录：--workspace 指定 agent 可读写的目录（默认当前目录）；会话文件绑定工作区，恢复对话时请在同一目录启动。

运行模式：
1. TUI：--mode tui，终端实时显示 FSM 状态、LLM 内容、工具调用、红绿 Diff 与 Token/Cache 指标。多轮对话：TUI 内直接输入即可继续对话，上下文自动延续（默认开启新对话、不自动落盘）；用 --session 恢复之前的会话，/save 或 --save-session 保存（默认路径 .reallity/session.json）。
2. WebUI（trace查看）：--mode web，启动本地 trace 查看器，浏览器打开 http://127.0.0.1:3000 查看 FSM DAG、Token/Cache 审计、事件时间线和 Diff。
3. Headless：--mode headless --task "..."，无界面执行，适合脚本与批量测试。

特色功能：
1.手写 FSM 状态机：7 个状态按合法转移表流转，非法跳转直接抛错。
  init→planner：任务开始先记录 git 基线，再进入规划。
  planner→executor：只输出 Checklist（禁止工具），产出后开工。
  executor→verify/rollback：本轮无工具调用自然收尾、或攒满 6 轮确有新改动时进 verify；连续 3 轮相同动作（停滞）去 rollback。
  verify→commit/executor/rollback：测试证据+模型审查 diff；通过进 commit，被拒带反馈回 executor，连续 3 次拒绝去 rollback。
  commit→finish：有改动即 git add -A 提交，只读任务跳过提交直接完成。
  rollback→planner：还原 agent 改动并重放任务前既有修改后重新规划。
  finish：收尾并生成 trace 审计。
2.Plan-Execute 双层规划：Planner 生成 Checklist，Executor 只处理当前子任务，避免目标漂移。
3.熔断与回滚：同类错误或审查拒绝连续 3 次触发熔断，先还原 agent 改动并重放任务前的既有修改，再回到 Planner 重新规划（不误删用户已有工作）。
4.AST 护栏：edit_file 修改 .ts/.tsx/.js/.jsx 文件前用 TypeScript AST 做语法诊断，语法错误拒绝写入；同时强制 Search/Replace 唯一匹配与 workspace 路径越界拦截。同时还对危险的bash命令进行正则匹配，避免造成不可逆的损失。
5.工具集：tool十分简练，只有这5个工具，足以支持对于项目级任务的处理。read_file、edit_file、bash、list_dir、glob。bash 注入非交互环境变量，30 秒超时并销毁进程树，避免阻塞。
6.可观测性：EventBus 实时记录结构化事件，任务结束生成 .reallity/traces/trace-时间戳.html，内含 Mermaid FSM 决策 DAG、Token/Cache 趋势与 Diff 审计。可以直接通过浏览器查看trace，方便快捷进行审计。
7.多轮会话：任务结束后在 TUI 输入框继续输入即开启下一任务，上一轮压缩为摘要进入工作记忆；会话 JSON 完整保留历史、工作记忆与全部事件，可用 --session 恢复继续对话。
8.只读模式：任务措辞含“统计/查看/分析/列出”等且无改动意图时自动进入只读模式，edit_file 与写类 bash（cat >、mkdir、npm install 等）被本地拦截；不跑测试，审查通过即结束。
9.语义 verify 软门禁：verify 阶段先跑测试收集证据，再由模型审查本轮 diff 并给出 approved/feedback；拒绝则带反馈跳回 executor 继续修。执行中每攒满 6 轮工具且确有新改动才强制 verify，纯读不打断。
10.防失控终止：连续 3 轮发出完全相同动作判为死循环，回滚重规划；交互上限默认 200，按 LLM 往返计数，任务持续推进不会被误杀。
