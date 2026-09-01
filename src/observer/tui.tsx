import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import Table from "./ink-table.tsx";
import { renderBanner } from "../banner.ts";
import { executeTool } from "../tools/executor.ts";
import type { AgentEvent, EventBus } from "./events.ts";
import type { AgentState } from "../fsm/types.ts";
import type { LLMUsage } from "../llm/types.ts";

interface TuiAppProps {
  bus: EventBus;
  model?: string;
  mode?: string;
  task?: string;
  tokenLimit?: number;
  workspaceRoot?: string;
}

interface DiffView {
  path: string;
  oldText: string;
  newText: string;
}

interface TuiSnapshot {
  state: AgentState;
  llm: string;
  tool: string;
  currentTool?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  toolStartedAt?: number;
  usage?: LLMUsage;
  events: number;
  running: boolean;
  summary?: string;
  success?: boolean;
}

interface WorkflowStep {
  label: string;
  status: "pending" | "active" | "done";
}

interface ActivityItem {
  text: string;
  color?: string;
}

function TuiApp({
  bus,
  model = "gpt-4.1-mini",
  mode = "tui",
  task = "",
  tokenLimit = 200_000,
  workspaceRoot = process.cwd(),
}: TuiAppProps) {
  const { stdout } = useStdout();
  const contentWidth = Math.max(40, stdout.columns - 4);
  const leftWidth = Math.max(34, Math.floor(contentWidth * 0.46));
  const rightWidth = Math.max(30, contentWidth - leftWidth - 2);
  const [showSplash, setShowSplash] = useState(true);
  const [snapshot, setSnapshot] = useState<TuiSnapshot>({
    state: "init",
    llm: "",
    tool: "",
    events: 0,
    running: true,
  });
  const [usageTotals, setUsageTotals] = useState<LLMUsage>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
  });
  const [diffs, setDiffs] = useState<DiffView[]>([]);
  const [command, setCommand] = useState("");
  const [expandedDiffs, setExpandedDiffs] = useState<Set<number>>(new Set());
  const [diffFocus, setDiffFocus] = useState(0);
  const [diffOffsets, setDiffOffsets] = useState<number[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityOffset, setActivityOffset] = useState(0);
  const [activityAutoFollow, setActivityAutoFollow] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 2_200);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activityAutoFollow) return;
    setActivityOffset(Math.max(0, activity.length - ACTIVITY_VIEWPORT));
  }, [activity, activityAutoFollow]);

  useEffect(
    () =>
      bus.subscribe((event) => {
        setSnapshot((current) => {
          const next = {
            ...current,
            events: current.events + 1,
            running: event.type !== "finish",
          };

          if (event.type === "state") {
            next.state = event.state;
          } else if (event.type === "llm") {
            next.llm = cleanLlmText(event.content);
            next.usage = event.usage;
          } else if (event.type === "tool_start") {
            next.tool = `Running ${event.tool}`;
            next.currentTool = event.tool;
            next.toolArgs = event.args;
            next.toolOutput = undefined;
            next.toolError = undefined;
            next.toolStartedAt = Date.now();
          } else if (event.type === "tool_result") {
            next.tool = `${event.tool} ${event.success ? "ok" : "failed"}`;
            next.toolOutput = event.output;
            next.toolError = event.error;
            next.toolStartedAt = undefined;
          } else if (event.type === "verification") {
            next.tool = event.passed ? "Tests passed" : "Tests failed";
          } else if (event.type === "error") {
            next.tool = event.message;
          } else if (event.type === "finish") {
            next.summary = event.answer || event.message;
            next.success = event.success;
          }

          return next;
        });

        if (event.type === "llm") {
          setUsageTotals((current) => ({
            promptTokens: current.promptTokens + event.usage.promptTokens,
            completionTokens:
              current.completionTokens + event.usage.completionTokens,
            totalTokens: current.totalTokens + event.usage.totalTokens,
            promptCacheHitTokens:
              current.promptCacheHitTokens + event.usage.promptCacheHitTokens,
            promptCacheMissTokens:
              current.promptCacheMissTokens + event.usage.promptCacheMissTokens,
          }));
        } else if (event.type === "tool_result" && event.diff) {
          setDiffs((current) => {
            const index = current.findIndex(
              (diff) => diff.path === event.diff?.path,
            );
            if (index === -1) {
              return [...current, event.diff!];
            }
            return current.map((diff, i) => (i === index ? event.diff! : diff));
          });
        }

        const activityItem = summarizeActivity(event);
        if (activityItem) {
          setActivity((current) => [...current, activityItem].slice(-80));
        }
      }),
    [bus],
  );

  useInput((input, key) => {
    if (input === "[") {
      setDiffFocus((current) => Math.max(0, current - 1));
      return;
    }
    if (input === "]") {
      setDiffFocus((current) =>
        Math.min(Math.max(0, diffs.length - 1), current + 1),
      );
      return;
    }
    if (input === "{") {
      setActivityAutoFollow(false);
      setActivityOffset((current) => Math.max(0, current - 1));
      return;
    }
    if (input === "}") {
      setActivityOffset((current) => {
        const max = Math.max(0, activity.length - ACTIVITY_VIEWPORT);
        const next = Math.min(max, current + 1);
        if (next >= max) setActivityAutoFollow(true);
        return next;
      });
      return;
    }
    if (input === "f") {
      setExpandedDiffs((current) => {
        const next = new Set(current);
        if (next.has(diffFocus)) {
          next.delete(diffFocus);
        } else {
          next.add(diffFocus);
        }
        return next;
      });
      return;
    }
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      setDiffOffsets((current) => {
        const next = [...current];
        next[diffFocus] = Math.max(0, (next[diffFocus] ?? 0) + delta);
        return next;
      });
      return;
    }
    if (key.return) {
      if (command.trim()) {
        void runCommand(command, workspaceRoot, (item) =>
          setActivity((current) => [...current, item].slice(-80)),
        );
      }
      setCommand("");
      return;
    }
    if (key.backspace) {
      setCommand((current) => current.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setCommand((current) => `${current}${input}`);
    }
  });

  if (showSplash) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{renderBanner("Reallity")}</Text>
        <Text color="gray">Starting Reallity...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" paddingX={1}>
      <Box flexDirection="column" width={leftWidth}>
        <Text>{renderBanner("Reallity", "Standard")}</Text>
        <Text color="gray">{"[ : | ]   { : scroll }   f : fold"}</Text>
        <Panel
          title="AUTOMATED WORKFLOWS"
          color="cyan"
          width={leftWidth}
          height={WORKFLOW_PANEL_HEIGHT}
        >
          <WorkflowView
            state={snapshot.state}
            task={task}
            currentTool={snapshot.currentTool}
            toolStartedAt={snapshot.toolStartedAt}
            toolError={snapshot.toolError}
            activity={activity}
            activityOffset={activityOffset}
            tick={tick}
            summary={snapshot.summary}
            success={snapshot.success}
          />
        </Panel>
        <Panel
          title="AGENT FSM STATUS"
          color="cyan"
          width={leftWidth}
          height={FSM_PANEL_HEIGHT}
        >
          <FsmView state={snapshot.state} width={leftWidth - 6} />
        </Panel>
      </Box>

      <Box flexDirection="column" width={rightWidth}>
        <Panel title="LLM CONTEXT" color="blue" width={rightWidth}>
          <Text color="white">Model: {model}</Text>
          <Text color="white">Persona: {mode}</Text>
          <Text color="white">
            Last Query Summary: {task || "(no task)"}
          </Text>
        </Panel>

        <Panel title="TOKEN STATISTICS" color="blue" width={rightWidth}>
          <TokenStats usage={usageTotals} limit={tokenLimit} />
        </Panel>

        <Panel
          title="FILE MODIFICATION DIFF"
          color="blue"
          width={rightWidth}
          height={DIFF_PANEL_HEIGHT}
        >
          <DiffViewer
            diffs={diffs}
            expandedDiffs={expandedDiffs}
            focus={diffFocus}
            offsets={diffOffsets}
            width={rightWidth - 6}
          />
        </Panel>

        <Panel title="INTERACTIVE COMMAND INPUT" color="cyan" width={rightWidth}>
          <Box flexDirection="row">
            <Text color="green">{"> AgentCommand: "}</Text>
            <Text color="white">{command}</Text>
            <Text color="gray">█</Text>
          </Box>
        </Panel>
      </Box>
    </Box>
  );
}

function paddedTitle(title: string, width: number): string {
  const prefix = "── ";
  const used = prefix.length + title.length + 1;
  const fill = Math.max(0, width - used);
  return `${prefix}${title} ${"─".repeat(fill)}`;
}

function Panel({
  title,
  color,
  width,
  height,
  children,
}: {
  title: string;
  color: string;
  width?: number;
  height?: number;
  children: React.ReactNode;
}) {
  const innerWidth = Math.max(10, (width ?? 40) - 4);
  return (
    <Box
      borderStyle="single"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      marginY={0}
      marginBottom={1}
      width={width}
      height={height}
      overflowY={height ? "hidden" : undefined}
    >
      <Text bold color={color}>
        {paddedTitle(title, innerWidth)}
      </Text>
      {children}
    </Box>
  );
}

function elapsedSeconds(startedAt: number | undefined): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function pseudoProgress(startedAt: number | undefined): number {
  if (!startedAt) return 0;
  return Math.min(95, elapsedSeconds(startedAt) * 15);
}

function renderProgressBar(pct: number, width = 16): string {
  const filled = Math.round((width * pct) / 100);
  return `[${"#".repeat(filled)}${"_".repeat(Math.max(0, width - filled))}] ${pct}%`;
}

const ACTIVITY_VIEWPORT = 8;
const WORKFLOW_CONTENT_LINES =
  1 /* task */ +
  1 /* planning */ +
  4 /* steps */ +
  1 /* activity header */ +
  ACTIVITY_VIEWPORT +
  1 /* summary, always reserved */;
export const WORKFLOW_PANEL_HEIGHT = WORKFLOW_CONTENT_LINES + 3; // title + top/bottom border

function WorkflowView({
  state,
  task,
  currentTool,
  toolStartedAt,
  toolError,
  activity,
  activityOffset,
  tick,
  summary,
  success,
}: {
  state: AgentState;
  task: string;
  currentTool?: string;
  toolStartedAt?: number;
  toolError?: string;
  activity: ActivityItem[];
  activityOffset: number;
  tick: number;
  summary?: string;
  success?: boolean;
}) {
  void tick; // force re-render each second so elapsed time / progress bar animate

  const steps: WorkflowStep[] = [
    { label: "ANALYZE", status: workflowStatus(state, "executor", "verify") },
    { label: "GENERATE", status: workflowStatus(state, "verify", "commit") },
    { label: "EXECUTE", status: workflowStatus(state, "commit", "finish") },
    { label: "FINISH", status: state === "finish" ? "done" : "pending" },
  ];
  const planning = workflowStatus(state, "planner", "executor");
  const visibleActivity = activity.slice(
    activityOffset,
    activityOffset + ACTIVITY_VIEWPORT,
  );
  const paddedActivity = [
    ...visibleActivity,
    ...Array.from(
      { length: Math.max(0, ACTIVITY_VIEWPORT - visibleActivity.length) },
      () => null,
    ),
  ];
  const hiddenAbove = activityOffset;
  const hiddenBelow = Math.max(
    0,
    activity.length - activityOffset - ACTIVITY_VIEWPORT,
  );

  return (
    <Box flexDirection="column">
      <Text color="white" wrap="truncate">
        Task: {task || "(no task)"}
      </Text>
      <Text color={statusColor(planning)} wrap="truncate">
        {"├─ "}PLANNING ({planning === "done" ? "✓" : planning === "active" ? ">" : " "})
      </Text>
      {steps.map((step, index) => {
        const failed = step.status === "active" && Boolean(toolError);
        const icon = failed ? "✗" : step.status === "done" ? "✓" : step.status === "active" ? ">" : " ";
        const color = failed ? "red" : statusColor(step.status);
        return (
          <Text key={step.label} color={color} wrap="truncate">
            {"├─ "}
            ({index + 1}) {step.label}
            {step.status === "active" && currentTool ? ` ${currentTool}` : ""}
            {" "}
            ({icon})
            {step.status === "active"
              ? ` ${renderProgressBar(pseudoProgress(toolStartedAt))} ${elapsedSeconds(toolStartedAt)}s`
              : step.status === "done"
                ? ""
                : " (Waiting)"}
          </Text>
        );
      })}
      <Text bold color="gray" wrap="truncate">
        {"└─ Activity "}
        {hiddenAbove > 0 ? `▲${hiddenAbove} ` : ""}
        {hiddenBelow > 0 ? `▼${hiddenBelow} ` : ""}
        {"({ }: scroll)"}
      </Text>
      {paddedActivity.map((item, index) => (
        <Text
          key={index}
          color={item?.color ?? "gray"}
          wrap="truncate"
          dimColor={!item}
        >
          {"   │ "}
          {item?.text ?? ""}
        </Text>
      ))}
      <Text
        bold
        color={
          state !== "finish" ? "gray" : success === false ? "red" : "green"
        }
        wrap="truncate"
      >
        {"   └─ "}
        {state === "finish" && summary
          ? `SUMMARY: ${summary}`
          : ""}
      </Text>
    </Box>
  );
}

// Mirrors LEGAL_TRANSITIONS in src/fsm/engine.ts so the panel always reflects
// the agent's real state machine, not an approximation of it.
function renderFsmNode(label: AgentState, current: AgentState) {
  const isCurrent = label === current;
  const color = stateColor(label);
  return (
    <Text
      key={label}
      color={isCurrent ? "black" : color}
      backgroundColor={isCurrent ? color : undefined}
      bold={isCurrent}
    >
      {isCurrent ? ` ${label.toUpperCase()} ` : label.toUpperCase()}
    </Text>
  );
}

function FsmEdgeRow({
  nodes,
  current,
  arrow = " > ",
  width,
}: {
  nodes: AgentState[];
  current: AgentState;
  arrow?: string;
  width: number;
}) {
  return (
    <Box flexDirection="row" width={width} overflowX="hidden">
      {nodes.map((node, index) => (
        <React.Fragment key={node}>
          {index > 0 ? <Text color="gray">{arrow}</Text> : null}
          {renderFsmNode(node, current)}
        </React.Fragment>
      ))}
    </Box>
  );
}

const FSM_CONTENT_LINES = 6;
export const FSM_PANEL_HEIGHT = FSM_CONTENT_LINES + 3; // title + top/bottom border

function FsmView({ state, width }: { state: AgentState; width: number }) {
  return (
    <Box flexDirection="column">
      <FsmEdgeRow
        nodes={["init", "planner", "executor"]}
        current={state}
        width={width}
      />
      <FsmEdgeRow
        nodes={["executor", "verify"]}
        current={state}
        width={width}
      />
      <Text color="gray" wrap="truncate">
        {"  retry: verify > executor"}
      </Text>
      <FsmEdgeRow
        nodes={["verify", "commit", "finish"]}
        current={state}
        width={width}
      />
      <Text color="gray" wrap="truncate">
        {"  fail:"}
      </Text>
      <FsmEdgeRow
        nodes={["verify", "rollback", "planner"]}
        current={state}
        width={width}
      />
    </Box>
  );
}

function TokenStats({ usage, limit }: { usage: LLMUsage; limit: number }) {
  const cost = (usage.promptTokens / 1_000_000) * 3 + (usage.completionTokens / 1_000_000) * 15;
  const remaining = Math.max(0, limit - usage.totalTokens);
  const rows: Array<[string, string]> = [
    ["Prompt Tokens:", usage.promptTokens.toLocaleString()],
    ["Completion Tokens:", usage.completionTokens.toLocaleString()],
    ["Total Tokens:", usage.totalTokens.toLocaleString()],
    ["Est. Cost:", `$${cost.toFixed(2)}`],
    ["Remaining Limit:", remaining.toLocaleString()],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return (
    <Box flexDirection="column">
      {rows.map(([label, value]) => (
        <Text key={label} color="white">
          {label.padEnd(labelWidth + 1)}
          {value}
        </Text>
      ))}
    </Box>
  );
}

const DIFF_CODE_VIEWPORT = 6;
const DIFF_CONTENT_LINES =
  1 /* file i/N + path */ +
  1 /* stat line */ +
  DIFF_CODE_VIEWPORT +
  1 /* range indicator, always reserved */ +
  1 /* legend */;
export const DIFF_PANEL_HEIGHT = DIFF_CONTENT_LINES + 3; // title + top/bottom border

// Shows only the focused diff (not every diff stacked) so the panel's height
// never depends on how many files were touched or how many are expanded.
function DiffViewer({
  diffs,
  expandedDiffs,
  focus,
  offsets,
  width,
}: {
  diffs: DiffView[];
  expandedDiffs: Set<number>;
  focus: number;
  offsets: number[];
  width: number;
}) {
  if (diffs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No file modifications yet</Text>
        {Array.from({ length: DIFF_CONTENT_LINES - 1 }, (_, i) => (
          <Text key={i}> </Text>
        ))}
      </Box>
    );
  }

  const index = Math.min(focus, diffs.length - 1);
  const diff = diffs[index];
  const expanded = expandedDiffs.has(index);
  const lines = [
    ...diff.oldText.split("\n").map((line) => ({ text: `- ${line}`, color: "red" })),
    ...diff.newText.split("\n").map((line) => ({ text: `+ ${line}`, color: "green" })),
  ];
  const offset = Math.min(
    offsets[index] ?? 0,
    Math.max(0, lines.length - DIFF_CODE_VIEWPORT),
  );
  const visible = expanded
    ? lines.slice(offset, offset + DIFF_CODE_VIEWPORT)
    : [];
  const filler = Array.from(
    { length: Math.max(0, DIFF_CODE_VIEWPORT - visible.length) },
    () => null,
  );

  return (
    <Box flexDirection="column">
      <Text color="cyan" wrap="truncate">
        File {index + 1}/{diffs.length}: {diff.path}
      </Text>
      <Text color="gray" wrap="truncate">
        {expanded ? "[-] " : "[+] "}
        {diff.oldText.split("\n").length + diff.newText.split("\n").length} lines changed
      </Text>
      {visible.map((line, lineIndex) => (
        <Text key={lineIndex} color={line.color} wrap="truncate">
          {truncateText(line.text, width)}
        </Text>
      ))}
      {filler.map((_, lineIndex) => (
        <Text key={`filler-${lineIndex}`}> </Text>
      ))}
      <Text color="gray">
        {expanded
          ? `${offset + 1}-${Math.min(lines.length, offset + DIFF_CODE_VIEWPORT)} / ${lines.length}`
          : "(press f to expand)"}
      </Text>
      <Text color="gray">[ ] move focus · f fold · ↑/↓ scroll diff</Text>
    </Box>
  );
}

function workflowStatus(
  state: AgentState,
  activeState: AgentState,
  doneAfterState: AgentState,
): WorkflowStep["status"] {
  if (state === activeState) return "active";
  if (stateOrder(state) >= stateOrder(doneAfterState)) return "done";
  return "pending";
}

function stateOrder(state: AgentState): number {
  return ["init", "planner", "executor", "verify", "commit", "finish", "rollback"].indexOf(
    state,
  );
}

function statusColor(status: WorkflowStep["status"]): string {
  if (status === "active") return "green";
  if (status === "done") return "cyan";
  return "gray";
}

function summarizeActivity(event: AgentEvent): ActivityItem | null {
  switch (event.type) {
    case "state":
      return { text: `state: ${event.state}`, color: "cyan" };
    case "llm":
      return {
        text: `LLM: ${cleanLlmText(event.content)}`,
        color: "white",
      };
    case "tool_start":
      return { text: `▶ ${event.tool}`, color: "yellow" };
    case "tool_result":
      return {
        text: `${event.tool} ${event.success ? "ok" : "failed"}${
          event.output || event.error
            ? `: ${summarizeToolResult(event)}`
            : ""
        }`,
        color: event.success ? "green" : "red",
      };
    case "verification":
      return {
        text: event.passed ? "✓ tests passed" : "✗ tests failed",
        color: event.passed ? "green" : "red",
      };
    case "diagnostic":
      return { text: event.diagnostic.message, color: "red" };
    case "checkpoint":
      return { text: `checkpoint ${event.head.slice(0, 8)}`, color: "gray" };
    case "checklist":
      return {
        text: `checklist: ${event.items.map((item) => item.id).join(" → ")}`,
        color: "cyan",
      };
    case "rollback":
      return {
        text: `rollback: ${event.message}`,
        color: event.success ? "yellow" : "red",
      };
    case "error":
      return { text: `error: ${event.message}`, color: "red" };
    case "finish":
      return { text: "finished", color: "green" };
  }
}

function summarizeToolResult(
  event: Extract<AgentEvent, { type: "tool_result" }>,
): string {
  const raw = event.output ?? event.error ?? "";
  return truncateText(raw.replace(/\s+/g, " ").trim(), 120);
}

async function runCommand(
  command: string,
  workspaceRoot: string,
  onItem: (item: ActivityItem) => void,
): Promise<void> {
  onItem({ text: `$ ${command}`, color: "yellow" });
  const result = await executeTool(
    {
      id: "agent-command",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command }),
      },
    },
    { workspaceRoot },
  );
  onItem({
    text: result.success ? result.output : (result.error ?? "command failed"),
    color: result.success ? "white" : "red",
  });
}

export function startTUI(
  bus: EventBus,
  options: {
    model?: string;
    mode?: string;
    task?: string;
    tokenLimit?: number;
    workspaceRoot?: string;
  } = {},
): () => void {
  const instance = render(<TuiApp bus={bus} {...options} />);
  return () => {
    instance.unmount();
  };
}

export function stateColor(state: AgentState): string {
  switch (state) {
    case "init":
      return "gray";
    case "planner":
      return "cyan";
    case "executor":
      return "yellow";
    case "verify":
      return "blue";
    case "commit":
      return "green";
    case "rollback":
      return "red";
    case "finish":
      return "green";
  }
}

export function cleanLlmText(content: string): string {
  const withoutToolTags = content
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "")
    .trim();
  return withoutToolTags || "(tool calls)";
}

export function tailLines(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const omitted = lines.length - maxLines;
  return [
    `... [${omitted} earlier lines hidden]`,
    ...lines.slice(-maxLines),
  ].join("\n");
}

export function formatMarkdownTable(lines: string[]): string[] {
  const rows = lines
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, ""))
    .filter((line) => line.length > 0)
    .map((line) =>
      line.split("|").map((cell) => cleanInlineMarkdown(cell.trim())),
    )
    .filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
  if (rows.length === 0) return [];
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(1, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const formatRow = (row: string[]) =>
    `| ${row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 1)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [
    formatRow(rows[0]),
    separator,
    ...rows.slice(1).map((row) => formatRow(row)),
  ];
}

export function parseMarkdownTableData(
  lines: string[],
): Array<Record<string, string>> {
  const rows = lines
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, ""))
    .filter((line) => line.length > 0)
    .map((line) =>
      line.split("|").map((cell) => cleanInlineMarkdown(cell.trim())),
    )
    .filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((row) => {
    const item: Record<string, string> = {};
    header.forEach((column, index) => {
      item[column || `col${index}`] = row[index] ?? "";
    });
    return item;
  });
}

function cleanInlineMarkdown(content: string): string {
  return content
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*>+\s?/, "");
}

function truncateText(content: string, maxWidth: number): string {
  if (content.length <= maxWidth) return content;
  return `${content.slice(0, Math.max(1, maxWidth - 1))}…`;
}
