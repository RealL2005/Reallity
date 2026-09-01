import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
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
  onTask?: (task: string) => void;
}

interface DiffView {
  path: string;
  oldText: string;
  newText: string;
}

interface TuiSnapshot {
  state: AgentState;
  llm: string;
  currentTool?: string;
  toolError?: string;
  usage?: LLMUsage;
  events: number;
  running: boolean;
  summary?: string;
}

interface ActivityItem {
  text: string;
  color?: string;
  id?: string;
  fullText?: string;
  kind?:
    | "llm"
    | "tool_start"
    | "tool_result"
    | "verification"
    | "checklist"
    | "rollback"
    | "error";
  tool?: string;
  args?: string;
  outputPreview?: string;
}

function TuiApp({
  bus,
  model = "gpt-4.1-mini",
  mode = "tui",
  task = "",
  tokenLimit = 200_000,
  workspaceRoot = process.cwd(),
  onTask,
}: TuiAppProps) {
  const { stdout } = useStdout();
  const width = Math.max(40, stdout.columns - 2);
  const height = Math.max(24, stdout.rows - 1);
  const [showSplash, setShowSplash] = useState(true);
  const [snapshot, setSnapshot] = useState<TuiSnapshot>({
    state: "init",
    llm: "",
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
  const [stateLog, setStateLog] = useState<
    Record<AgentState, ActivityItem[]>
  >({
    init: [],
    planner: [],
    executor: [],
    verify: [],
    commit: [],
    rollback: [],
    finish: [],
  });
  const currentStateRef = useRef<AgentState>("init");
  const [workflowOffset, setWorkflowOffset] = useState(0);
  const [summaryOffset, setSummaryOffset] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [lastLlmId, setLastLlmId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 1_500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(
    () =>
      bus.subscribe((event) => {
        setSnapshot((current) => {
          const next = {
            ...current,
            events: current.events + 1,
            running: event.type !== "finish",
          };
          if (event.type === "state") next.state = event.state;
          if (event.type === "llm") next.llm = cleanLlmText(event.content);
          if (event.type === "tool_start") next.currentTool = event.tool;
          if (event.type === "tool_result") next.toolError = event.error;
          if (event.type === "finish")
            next.summary = event.answer || event.message;
          return next;
        });

        if (event.type === "state") currentStateRef.current = event.state;
        if (event.type === "llm") {
          setLastLlmId(`llm-${event.timestamp}`);
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
            if (index === -1) return [...current, event.diff!];
            return current.map((diff, i) => (i === index ? event.diff! : diff));
          });
        }

        const item = summarizeActivity(event);
        if (item && event.type !== "state") {
          setStateLog((current) => {
            const state = currentStateRef.current;
            return {
              ...current,
              [state]: [...current[state], item],
            };
          });
        }
      }),
    [bus],
  );

  useInput((input, key) => {
    if (command.length === 0) {
      if (input === "w") {
        setWorkflowOffset((current) => Math.max(0, current - 1));
        return;
      }
      if (input === "s") {
        setWorkflowOffset((current) => current + 1);
        return;
      }
      if (input === "{") {
        setSummaryOffset((current) => Math.max(0, current - 1));
        return;
      }
      if (input === "}") {
        setSummaryOffset((current) => current + 1);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setWorkflowOffset((current) =>
          Math.max(0, current + (key.upArrow ? -1 : 1)),
        );
        return;
      }
      if (key.pageUp || key.pageDown) {
        setSummaryOffset((current) =>
          Math.max(0, current + (key.pageUp ? -1 : 1)),
        );
        return;
      }
      if (key.return && lastLlmId) {
        setExpandedIds((current) => {
          const next = new Set(current);
          if (next.has(lastLlmId)) next.delete(lastLlmId);
          else next.add(lastLlmId);
          return next;
        });
        return;
      }
    }

    if (key.return) {
      if (command.trim()) {
        const taskCommand = parseTaskCommand(command);
        if (taskCommand) onTask?.(taskCommand);
        else void runCommand(command, workspaceRoot, (item) => appendItem(item));
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

  function appendItem(item: ActivityItem) {
    setStateLog((current) => {
      const state = currentStateRef.current;
      return { ...current, [state]: [...current[state], item] };
    });
  }

  if (showSplash) {
    return (
      <Box flexDirection="column">
        <Text>{renderBanner("Reallity", "Small")}</Text>
        <Text color="gray">Starting Reallity...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text>{renderBanner("Reallity", "Small")}</Text>
      <Panel title="AUTOMATED WORKFLOWS" color="cyan" height={height - 18}>
        <WorkflowView
          state={snapshot.state}
          task={task}
          stateLog={stateLog}
          expandedIds={expandedIds}
          width={width - 4}
          height={height - 20}
          offset={workflowOffset}
        />
      </Panel>
      <Panel title="FINAL SUMMARY" color="green" height={7}>
        <SummaryView
          summary={snapshot.summary ?? ""}
          offset={summaryOffset}
          width={width - 4}
          height={5}
        />
      </Panel>
      <Panel title="FILE MODIFICATION DIFF" color="blue" height={10}>
        <DiffViewer diffs={diffs} width={width - 4} height={8} />
      </Panel>
      <Panel title="LLM CONTEXT" color="blue" height={4}>
        <Text wrap="truncate">
          {model} · {mode} · {task || "(no task)"}
        </Text>
        <Text wrap="truncate">{snapshot.llm}</Text>
      </Panel>
      <Panel title="TOKEN STATISTICS" color="blue" height={4}>
        <Text>total {usageTotals.totalTokens} · prompt {usageTotals.promptTokens} · completion {usageTotals.completionTokens}</Text>
        <Text color="gray">remaining {Math.max(0, tokenLimit - usageTotals.totalTokens)} / {tokenLimit}</Text>
      </Panel>
      <Panel title="INTERACTIVE COMMAND INPUT" color="cyan" height={3}>
        <Text>
          {" > "}
          {command}
          <Text color="gray">█</Text>
        </Text>
      </Panel>
    </Box>
  );
}

function Panel({
  title,
  color,
  height,
  children,
}: {
  title: string;
  color: string;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      marginBottom={1}
      height={height}
      overflowY="hidden"
    >
      <Text bold color={color}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

function WorkflowView({
  state,
  task,
  stateLog,
  expandedIds,
  width,
  height,
  offset,
}: {
  state: AgentState;
  task: string;
  stateLog: Record<AgentState, ActivityItem[]>;
  expandedIds: Set<string>;
  width: number;
  height: number;
  offset: number;
}) {
  const lines: React.ReactNode[] = [
    <Text key="task" wrap="truncate">
      Task: {task}
    </Text>,
  ];
  const order: AgentState[] = [
    "init",
    "planner",
    "executor",
    "verify",
    "commit",
    "rollback",
    "finish",
  ];
  for (const item of order) {
    if (!stateLog[item].length && item !== state) continue;
    lines.push(
      <Text key={`state-${item}`} color={item === state ? "green" : "cyan"}>
        {item === state ? "> " : "  "}
        {item}
      </Text>,
    );
    for (const entry of stateLog[item]) {
      const expanded = entry.id && expandedIds.has(entry.id);
      const text = entry.fullText && expanded ? entry.fullText : entry.text;
      lines.push(
        <Text key={`${item}-${lines.length}`} color={entry.color ?? "gray"} wrap="truncate">
          {"    "}
          {truncateText(text, width)}
        </Text>,
      );
    }
  }
  return <Scrollable lines={lines} height={height} offset={offset} />;
}

function SummaryView({
  summary,
  offset,
  width,
  height,
}: {
  summary: string;
  offset: number;
  width: number;
  height: number;
}) {
  const raw = summary.trim() ? summary.split("\n") : ["Waiting for final summary..."];
  const lines = raw.map((line, index) => (
    <Text key={index} wrap="truncate">
      {truncateText(line, width)}
    </Text>
  ));
  return <Scrollable lines={lines} height={height} offset={offset} />;
}

function DiffViewer({
  diffs,
  width,
  height,
}: {
  diffs: DiffView[];
  width: number;
  height: number;
}) {
  if (!diffs.length) return <Text color="gray">No file modifications yet</Text>;
  const all = diffs.flatMap((diff) => [
    <Text key={diff.path} color="cyan">
      {diff.path}
    </Text>,
    ...diff.oldText.split("\n").map((line, i) => (
      <Text key={`${diff.path}-old-${i}`} color="red" wrap="truncate">
        {truncateText(`- ${line}`, width)}
      </Text>
    )),
    ...diff.newText.split("\n").map((line, i) => (
      <Text key={`${diff.path}-new-${i}`} color="green" wrap="truncate">
        {truncateText(`+ ${line}`, width)}
      </Text>
    )),
  ]);
  return <Scrollable lines={all} height={height} offset={0} />;
}

function Scrollable({
  lines,
  height,
  offset,
}: {
  lines: React.ReactNode[];
  height: number;
  offset: number;
}) {
  const max = Math.max(0, lines.length - height);
  const clamped = Math.min(offset, max);
  const visible = lines.slice(clamped, clamped + height);
  while (visible.length < height) visible.push(<Text key={`pad-${visible.length}`}> </Text>);
  return (
    <Box flexDirection="column">
      {visible}
      <Text color="gray">
        {clamped + 1}-{Math.min(lines.length, clamped + height)} / {lines.length}
      </Text>
    </Box>
  );
}

function summarizeActivity(event: AgentEvent): ActivityItem | null {
  switch (event.type) {
    case "llm":
      return {
        kind: "llm",
        id: `llm-${event.timestamp}`,
        text: "LLM Output",
        fullText: cleanLlmText(event.content),
        color: "white",
      };
    case "tool_start":
      return {
        kind: "tool_start",
        text: `▶ ${event.tool}`,
        tool: event.tool,
        args: formatToolArgs(event.args ?? {}),
        color: "yellow",
      };
    case "tool_result":
      return {
        kind: "tool_result",
        id: `${event.tool}-${event.timestamp}`,
        text: `${event.tool} ${event.success ? "ok" : "failed"}: ……`,
        fullText: `${event.tool} ${event.success ? "ok" : "failed"}:\n${
          event.output || event.error || ""
        }`,
        color: event.success ? "green" : "red",
      };
    case "checklist":
      return {
        kind: "checklist",
        text: `checklist: ${event.items.map((item) => item.id).join(" → ")}`,
        color: "cyan",
      };
    case "verification":
      return {
        kind: "verification",
        text: event.passed ? "✓ tests passed" : "✗ tests failed",
        color: event.passed ? "green" : "red",
      };
    case "rollback":
      return { kind: "rollback", text: `rollback: ${event.message}`, color: "yellow" };
    case "error":
      return { kind: "error", text: `error: ${event.message}`, color: "red" };
    default:
      return null;
  }
}

function formatToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

function parseTaskCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.startsWith("/task ")) return trimmed.slice("/task ".length).trim();
  if (trimmed.startsWith("task:")) return trimmed.slice("task:".length).trim();
  return null;
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
      function: { name: "bash", arguments: JSON.stringify({ command }) },
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
    onTask?: (task: string) => void;
  } = {},
): () => void {
  const instance = render(<TuiApp bus={bus} {...options} />);
  return () => instance.unmount();
}

export function stateColor(state: AgentState): string {
  switch (state) {
    case "init": return "gray";
    case "planner": return "cyan";
    case "executor": return "yellow";
    case "verify": return "blue";
    case "commit": return "green";
    case "rollback": return "red";
    case "finish": return "green";
  }
}

export function cleanLlmText(content: string): string {
  const without = content.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "").trim();
  return without || "(tool calls)";
}

export function tailLines(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const omitted = lines.length - maxLines;
  return [`... [${omitted} earlier lines hidden]`, ...lines.slice(-maxLines)].join("\n");
}

export function formatMarkdownTable(lines: string[]): string[] {
  const rows = lines
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => line.split("|").map((cell) => cleanInlineMarkdown(cell.trim())))
    .filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
  if (!rows.length) return [];
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(1, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const formatRow = (row: string[]) =>
    `| ${row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 1)).join(" | ")} |`;
  const separator = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  return [formatRow(rows[0]), separator, ...rows.slice(1).map(formatRow)];
}

export function parseMarkdownTableData(lines: string[]): Array<Record<string, string>> {
  const rows = lines
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => line.split("|").map((cell) => cleanInlineMarkdown(cell.trim())))
    .filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
  if (!rows.length) return [];
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
