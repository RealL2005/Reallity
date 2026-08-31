# Reallity Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native TypeScript/Bun coding agent harness with a handwritten FSM, plan-execute loop, tool registry, AST guardrails, TDD diagnostic loop, dual-mode UI, and checkpoint/rollback governance.

**Architecture:** The harness separates deterministic control flow (FSM, tool validation, diagnostics) from model-specific streaming. The agent loop runs Init -> Planner -> Executor -> Verify -> Commit/Rollback. Tools are Zod-validated and execute locally. Tests provide a hard verification gate; a single-pass LLM review is the soft gate.

**Tech Stack:** TypeScript, Bun runtime/test runner, Zod, execa, Ink/React TUI, native Fetch API for OpenAI-compatible tool calling, Git CLI for checkpoints.

**Spec:** `RealL (Reality) - Native Coding Agent Harness 完整架构与规范.md`

## Global Constraints

- No agent frameworks or SDKs.
- No hosted code execution or file APIs.
- Handwritten context management, tool execution, response parsing, termination, and error handling.
- API keys only via environment variables or ignored config files.
- Maximum 20 interaction rounds per task.
- Three identical errors trigger circuit-breaker rollback.
- `edit_file` requires exactly one unique match.
- File tools enforce workspace_root boundary.
- Shell commands get non-interactive environment, 30s timeout, process-tree kill, head/tail truncation.

---

## Task 0: Project scaffold and verification baseline

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/version.ts`
- Test: `tests/version.test.ts`

**Interfaces:**
- Produces: `VERSION` string constant.

- [ ] **Step 1: Write failing test**

```ts
import { test, expect } from "bun:test";
import { VERSION } from "../../src/version.ts";

test("VERSION follows semver", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/version.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

Create `src/version.ts` with `export const VERSION = "0.1.0";`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/version.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore src/version.ts tests/version.test.ts
git commit -m "chore: scaffold Bun/TypeScript project"
```

---

## Task 1: Error taxonomy and diagnostics

**Files:**
- Create: `src/core/diagnostics.ts`
- Test: `tests/core/diagnostics.test.ts`

**Interfaces:**
- Produces: `class AgentError extends Error`, `class CircuitBreakerError extends AgentError`, `parseDiagnostic(text: string): Diagnostic`.

- [ ] Write failing tests for `AgentError` fields, `CircuitBreakerError`, and `parseDiagnostic` extracting file/line/message/expected/actual from Bun test stderr.
- [ ] Run tests and verify failures.
- [ ] Implement minimal types and parser.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 2: Context and working memory manager

**Files:**
- Create: `src/core/context.ts`
- Test: `tests/core/context.test.ts`

**Interfaces:**
- Produces: `WorkingMemory`, `ContextManager` with `system`, `history`, `workingMemory`, `appendUser`, `appendAssistant`, `appendTool`, `truncate`, `serializeOpenAI`.

- [ ] Write failing tests for history append, tool-result head/tail truncation, working memory updates, and serialization.
- [ ] Run tests and verify failures.
- [ ] Implement minimal class.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 3: Tool schemas and guardrail validation

**Files:**
- Create: `src/tools/schemas.ts`, `src/tools/guards.ts`
- Test: `tests/tools/guards.test.ts`

**Interfaces:**
- Produces: `ToolName`, `TOOL_SCHEMAS`, `assertInsideWorkspace`, `assertUniqueMatch`, `buildBashEnv`, `classifyHighRiskCommand`.

- [ ] Write failing tests for workspace path boundary, unique search/replace matching, shell env injection, and high-risk command regex.
- [ ] Run tests and verify failures.
- [ ] Implement minimal validators.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 4: Local tool executor

**Files:**
- Create: `src/tools/registry.ts`, `src/tools/executor.ts`
- Test: `tests/tools/executor.test.ts`

**Interfaces:**
- Produces: `ToolRegistry` and `executeTool(call: ToolCall, ctx: ExecutorContext): Promise<ToolResult>`.

- [ ] Write failing tests for read_file paging, edit_file unique-match semantics, list_dir/glob, and bash timeout/truncation.
- [ ] Run tests and verify failures.
- [ ] Implement executor.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 5: LLM adapter with retries and SSE parsing

**Files:**
- Create: `src/llm/types.ts`, `src/llm/retry.ts`, `src/llm/sse.ts`, `src/llm/client.ts`
- Test: `tests/llm/retry.test.ts`, `tests/llm/sse.test.ts`, `tests/llm/client.test.ts`

**Interfaces:**
- Produces: `retryWithBackoff`, `parseSSEChunks`, `OpenAICompatibleClient` with `streamCompletion`.

- [ ] Write failing tests for exponential backoff with jitter, SSE event parsing across chunk boundaries, and request body/tool schema mapping.
- [ ] Run tests and verify failures.
- [ ] Implement adapter.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 6: FSM core and circuit breaker

**Files:**
- Create: `src/fsm/types.ts`, `src/fsm/planner.ts`, `src/fsm/engine.ts`
- Test: `tests/fsm/engine.test.ts`, `tests/fsm/planner.test.ts`

**Interfaces:**
- Produces: `AgentState`, `AgentEvent`, `CircuitBreaker`, `FSMEngine`.

- [ ] Write failing tests for legal state transitions, hard verify gate, 20-round limit, and 3-identical-error breaker.
- [ ] Run tests and verify failures.
- [ ] Implement FSM.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 7: TDD diagnostic loop and hard verification gate

**Files:**
- Create: `src/verify/runner.ts`, `src/verify/review.ts`
- Test: `tests/verify/runner.test.ts`, `tests/verify/review.test.ts`

**Interfaces:**
- Produces: `runBunTests`, `buildVerificationResult`, `buildReviewPrompt`.

- [ ] Write failing tests for test command detection, diagnostic extraction, and review prompt packing.
- [ ] Run tests and verify failures.
- [ ] Implement loop.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 8: Checkpoint and rollback governance

**Files:**
- Create: `src/governance/checkpoint.ts`
- Test: `tests/governance/checkpoint.test.ts`

**Interfaces:**
- Produces: `GitCheckpoint` with `capture`, `rollback`, `isClean`.

- [ ] Write failing tests using a temporary git repo for capture/rollback behavior.
- [ ] Run tests and verify failures.
- [ ] Implement.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 9: Observer event bus and trace HTML

**Files:**
- Create: `src/observer/events.ts`, `src/observer/trace.ts`, `src/observer/tui.tsx`
- Test: `tests/observer/trace.test.ts`

**Interfaces:**
- Produces: `AgentEvent`, `EventBus`, `buildTraceHtml`.

- [ ] Write failing tests for event ordering and trace HTML containing Mermaid DAG and events.
- [ ] Run tests and verify failures.
- [ ] Implement event bus and trace generator; add minimal TUI.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 9.5: Core agent orchestration

**Files:**
- Create: `src/agent.ts`
- Modify: `src/governance/checkpoint.ts`
- Test: `tests/agent.test.ts`, `tests/governance/checkpoint.test.ts`

**Interfaces:**
- Produces: `ReallityAgent` with `run(task)`, checkpoint `diff()` and `commitAll()`.

- [ ] Write failing tests for plan/execute/verify/commit and checkpoint diff/commit.
- [ ] Run tests and verify failures.
- [ ] Implement orchestration loop.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 9.6: AST guardrail

**Files:**
- Create: `src/guards/ast.ts`
- Modify: `src/tools/executor.ts`
- Test: `tests/guards/ast.test.ts`, `tests/tools/executor.test.ts`

**Interfaces:**
- Produces: `isCodeFile`, `analyzeSource`, `analyzeFile`; `edit_file` rejects invalid JS/TS syntax before writing.

- [ ] Write failing tests for valid/invalid TypeScript analysis and executor rejection.
- [ ] Run tests and verify failures.
- [ ] Implement guardrail and integrate with edit_file.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 10: WebUI and CLI entrypoint

**Files:**
- Create: `src/cli.ts`, `src/web/server.ts`, `src/web/index.html`
- Test: `tests/cli.test.ts`, `tests/web/server.test.ts`

**Interfaces:**
- Produces: `startWebUI`, `parseCliArgs`.

- [ ] Write failing tests for CLI mode parsing and web server health endpoint.
- [ ] Run tests and verify failures.
- [ ] Implement.
- [ ] Run tests and verify pass.
- [ ] Commit.

---

## Task 11: README and final verification

**Files:**
- Create: `README.txt`
- Verify: full `bun test`, `bunx tsc --noEmit`, `bun run src/cli.ts --help`.

- [ ] Write README.txt under 1000 Chinese characters with repo URL, single command, TUI/WebUI, and AST guardrail features.
- [ ] Run full verification.
- [ ] Commit.
