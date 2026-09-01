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
  const contentWidth = Math.max(40, stdout.columns - 2);
  const leftWidth = Math.floor(contentWidth / 2);
  const rightWidth = contentWidth - leftWidth;
  const terminalHeight = Math.max(28, stdout.rows - 2);
  const bannerHeight = 5;
  const summaryHeight = 8;
  const innerHeight = Math.max(20, terminalHeight - bannerHeight - 1);
  const workflowHeight = Math.max(8, innerHeight - summaryHeight - 1);
  const llmHeight = 4;
  const tokenHeight = 5;
  const commandHeight = 3;
  const diffHeight = Math.max(
    8,
    innerHeight - llmHeight - tokenHeight - commandHeight - 4,
  );
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
  const [expandedDiffs, setExpandedDiffs] = useState<Set<number>>(new Set());
  const [diffFocus, setDiffFocus] = useState(0);
  const [diffOffsets, setDiffOffsets] = useState<number[]>([]);
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
  const [summaryOffset, setSummaryOffset] = useState(0);
  const [workflowOffset, setWorkflowOffset] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 2_200);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 700);
    return () => clearInterval(timer);
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

          if (event.type === "state") {
            next.state = event.state;
          } else if (event.type === "llm") {
            next.llm = cleanLlmText(event.content);
            next.usage = event.usage;
          } else if (event.type === "tool_start") {
            next.currentTool = event.tool;
            next.toolError = undefined;
          } else if (event.type === "tool_result") {
            next.currentTool = event.tool;
            next.toolError = event.error;
          } else if (event.type === "finish") {
            next.summary = event.answer || event.message;
          }

          return next;
        });

        if (event.type === "state") {
          currentStateRef.current = event.state;
        }
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
      if (input === "f") {
        setExpandedDiffs((current) => {
          const next = new Set(current);
          if (next.has(diffFocus)) next.delete(diffFocus);
          else next.add(diffFocus);
          return next;
        });
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setWorkflowOffset((current) => Math.max(0, current + delta));
        return;
      }
      if (key.pageUp || key.pageDown) {
        const delta = key.pageUp ? -1 : 1;
        setSummaryOffset((current) => Math.max(0, current + delta));
        return;
      }
      if (input === "j" || input === "k") {
        const delta = input === "k" ? -1 : 1;
        setDiffOffsets((current) => {
          const next = [...current];
          next[diffFocus] = Math.max(0, (next[diffFocus] ?? 0) + delta);
          return next;
        });
        return;
      }
    }
    if (key.return) {
      if (command.trim()) {
        const taskCommand = parseTaskCommand(command);
        if (taskCommand) {
          onTask?.(taskCommand);
        } else {
          void runCommand(command, workspaceRoot, (item) =>
            setStateLog((current) => {
              const state = currentStateRef.current;
              return {
                ...current,
                [state]: [...current[state], item],
              };
            }),
          );
        }
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
        <Text>{renderBanner("Reallity", "Small")}</Text>
        <Text color="gray">Starting Reallity...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={contentWidth} height={terminalHeight}>
      <Text>{renderBanner("Reallity", "Small")}</Text>
      <Box flexDirection="row" height={innerHeight} width={contentWidth}>
        <Box flexDirection="column" width={leftWidth} height={innerHeight}>
          <Panel
            title="AUTOMATED WORKFLOWS"
            color="cyan"
            height={workflowHeight}
            width={leftWidth - 2}
          >
            <WorkflowView
              state={snapshot.state}
              task={task}
              stateLog={stateLog}
              summary={snapshot.summary}
              summaryOffset={summaryOffset}
              tick={tick}
              workflowOffset={workflowOffset}
              height={workflowHeight - 3}
              width={leftWidth - 6}
            />
          </Panel>
          <Panel
            title="FINAL SUMMARY"
            color="green"
            height={summaryHeight}
            width={leftWidth - 2}
          >
            <SummaryView
              summary={snapshot.summary ?? ""}
              offset={summaryOffset}
              height={summaryHeight - 3}
              width={leftWidth - 6}
            />
          </Panel>
        </Box>

        <Box flexDirection="column" width={rightWidth} height={innerHeight}>
          <Panel title="LLM CONTEXT" color="blue" height={llmHeight} width={rightWidth - 2}>
            <Text color="white">model: {model}</Text>
            <Text color="white">mode: {mode}</Text>
            <Text color="white">task: {task || "(no task)"}</Text>
            {snapshot.llm ? (
              <Text color="gray" wrap="truncate">
                {truncateText(snapshot.llm, rightWidth - 6)}
              </Text>
            ) : null}
          </Panel>

          <Panel title="TOKEN STATISTICS" color="blue" height={tokenHeight} width={rightWidth - 2}>
            <TokenStats usage={usageTotals} limit={tokenLimit} />
          </Panel>

          <Panel
            title="FILE MODIFICATION DIFF"
            color="blue"
            height={diffHeight}
            width={rightWidth - 2}
          >
            <DiffViewer
              diffs={diffs}
              expandedDiffs={expandedDiffs}
              focus={diffFocus}
              offsets={diffOffsets}
              width={rightWidth - 6}
              height={diffHeight - 3}
            />
          </Panel>

          <Panel
            title="INTERACTIVE COMMAND INPUT"
            color="cyan"
            height={commandHeight}
            width={rightWidth - 2}
          >
            <Box flexDirection="row">
              <Text color="green">{"> AgentCommand: "}</Text>
              <Text color="white">{command}</Text>
              <Text color="gray">█</Text>
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}

function Panel({
  title,
  color,
  height,
  width,
  children,
}: {
  title: string;
  color: string;
  height?: number;
  width?: number;
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
      width={width}
      overflowY={height ? "hidden" : undefined}
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
  summary,
  summaryOffset,
  tick,
  workflowOffset,
  height,
  width,
}: {
  state: AgentState;
  task: string;
  stateLog: Record<AgentState, ActivityItem[]>;
  summary?: string;
  summaryOffset: number;
  tick: number;
  workflowOffset: number;
  height: number;
  width: number;
}) {
  const order: AgentState[] = [
    "init",
    "planner",
    "executor",
    "verify",
    "commit",
    "rollback",
    "finish",
  ];
  const visibleStates = order.filter(
    (item) => item === state || stateLog[item].length > 0,
  );
  const failedVerify = stateLog.verify.some((entry) =>
    entry.text.includes("✗ tests failed"),
  );
  const lines: React.ReactNode[] = [
    <Text key="task" color="white" wrap="truncate">
      Task: {task || "(no task)"}
    </Text>,
    ...renderTopologyLines(state, failedVerify, tick),
  ];

  for (const item of visibleStates) {
    lines.push(
      <Text key={`state-${item}`} color={item === state ? "green" : "cyan"}>
        {item === state ? "> " : "  "}
        {item}
      </Text>,
    );
    for (const entry of stateLog[item]) {
      lines.push(
        <Text key={`${item}-${lines.length}`} color={entry.color ?? "gray"} wrap="truncate">
          {"    "}
          {entry.text}
        </Text>,
      );
    }
  }

  return (
    <ScrollableContent
      lines={lines}
      height={height}
      offset={workflowOffset}
      width={width}
    />
  );
}

function renderTopologyLines(
  state: AgentState,
  failedVerify: boolean,
  tick: number,
): React.ReactNode[] {
  const order: AgentState[] = [
    "init",
    "planner",
    "executor",
    "verify",
    "commit",
    "finish",
  ];
  const stateIndex = order.indexOf(state);
  const blink = tick % 2 === 0;
  const nodes: React.ReactNode[] = [];
  nodes.push(
    <Text key="topology" color="gray">
      {order.map((item, index) => {
        const reached = stateIndex >= index;
        const active = item === state;
        const skipped = !reached;
        return (
          <Text
            key={item}
            color={active ? "green" : skipped ? "gray" : "cyan"}
            inverse={active && blink}
          >
            {active ? "[● " : "["}
            {item}
            {active ? "]" : "]"}
            {index < order.length - 1 ? " ─▶ " : ""}
          </Text>
        );
      })}
    </Text>,
  );
  if (failedVerify) {
    nodes.push(
      <Text key="fail" color="yellow" inverse={blink}>
        verify --(fail)--▶ executor
      </Text>,
    );
  }
  nodes.push(
    <Text key="rollback" color="gray">
      rollback ─▶ planner
    </Text>,
  );
  return nodes;
}

function SummaryView({
  summary,
  offset,
  height,
  width,
}: {
  summary: string;
  offset: number;
  height: number;
  width: number;
}) {
  const rawLines = summary.trim()
    ? summary.split("\n")
    : ["Waiting for final summary..."];
  const lines = rawLines.map((line, index) => (
    <Text key={index} wrap="truncate">
      {line}
    </Text>
  ));
  return (
    <ScrollableContent
      lines={lines}
      height={height}
      offset={offset}
      width={width}
    />
  );
}

function ScrollableContent({
  lines,
  height,
  offset,
  width,
}: {
  lines: React.ReactNode[];
  height: number;
  offset: number;
  width: number;
}) {
  const maxOffset = Math.max(0, lines.length - height);
  const clamped = Math.min(offset, maxOffset);
  const visible = lines.slice(clamped, clamped + height);
  while (visible.length < height) {
    visible.push(<Text key={`pad-${visible.length}`}> </Text>);
  }
  const thumbHeight = Math.max(
    1,
    Math.floor((height / Math.max(1, lines.length)) * height),
  );
  const thumbTop =
    maxOffset === 0
      ? 0
      : Math.floor((clamped / maxOffset) * (height - thumbHeight));

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={Math.max(1, width - 1)}>
        {visible}
      </Box>
      <Box flexDirection="column" width={1}>
        {Array.from({ length: height }, (_, index) => (
          <Text key={index} color="gray">
            {index >= thumbTop && index < thumbTop + thumbHeight ? "█" : "│"}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function TokenStats({ usage, limit }: { usage: LLMUsage; limit: number }) {
  const cost =
    (usage.promptTokens / 1_000_000) * 3 +
    (usage.completionTokens / 1_000_000) * 15;
  const remaining = Math.max(0, limit - usage.totalTokens);
  return (
    <Box flexDirection="column">
      <Text color="white">prompt: {usage.promptTokens}</Text>
      <Text color="white">completion: {usage.completionTokens}</Text>
      <Text color="white">total: {usage.totalTokens}</Text>
      <Text color="yellow">est cost: ${cost.toFixed(4)}</Text>
      <Text color="gray">
        remaining: {remaining} / {limit}
      </Text>
    </Box>
  );
}

function DiffViewer({
  diffs,
  expandedDiffs,
  focus,
  offsets,
  width,
  height,
}: {
  diffs: DiffView[];
  expandedDiffs: Set<number>;
  focus: number;
  offsets: number[];
  width: number;
  height: number;
}) {
  if (diffs.length === 0) {
    return <Text color="gray">No file modifications yet</Text>;
  }

  const viewport = Math.max(3, height - 3);

  return (
    <Box flexDirection="column">
      {diffs.map((diff, index) => {
        const expanded = expandedDiffs.has(index);
        const lines = [
          ...diff.oldText.split("\n").map((line) => ({ text: `- ${line}`, color: "red" })),
          ...diff.newText.split("\n").map((line) => ({ text: `+ ${line}`, color: "green" })),
        ];
        const offset = Math.min(
          offsets[index] ?? 0,
          Math.max(0, lines.length - viewport),
        );
        const visible = lines.slice(offset, offset + viewport);
        return (
          <Box flexDirection="column" key={`${diff.path}-${index}`}>
            <Text color={index === focus ? "cyan" : "gray"}>
              {expanded ? "[-] " : "[+] "}
              {diff.path} · {lines.length} lines
            </Text>
            {expanded ? (
              <Box flexDirection="column">
                {visible.map((line, lineIndex) => (
                  <Text key={lineIndex} color={line.color} wrap="truncate">
                    {truncateText(line.text, width)}
                  </Text>
                ))}
                <Text color="gray">
                  {offset + 1}-{Math.min(lines.length, offset + viewport)} / {lines.length}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Text color="gray">[ ] move focus · f fold · ↑/↓ scroll diff</Text>
    </Box>
  );
}

function summarizeActivity(event: AgentEvent): ActivityItem | null {
  switch (event.type) {
    case "llm":
      return { text: `LLM: ${cleanLlmText(event.content)}`, color: "white" };
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
    case "state":
      return null;
  }
}

function summarizeToolResult(
  event: Extract<AgentEvent, { type: "tool_result" }>,
): string {
  const raw = event.output ?? event.error ?? "";
  return truncateText(raw.replace(/\s+/g, " ").trim(), 120);
}

function parseTaskCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.startsWith("/task ")) {
    return trimmed.slice("/task ".length).trim();
  }
  if (trimmed.startsWith("task:")) {
    return trimmed.slice("task:".length).trim();
  }
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
    onTask?: (task: string) => void;
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
