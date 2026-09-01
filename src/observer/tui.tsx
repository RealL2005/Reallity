import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import wrapAnsi from "wrap-ansi";
import cliTruncate from "cli-truncate";
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
  errorSignature?: string;
}

interface ColoredLine {
  text: string;
  color?: string;
  wrap?: boolean;
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
  const topologyHeight = 4;
  const innerHeight = Math.max(20, terminalHeight - bannerHeight - 1);
  const workflowHeight = Math.max(
    8,
    innerHeight - summaryHeight - topologyHeight,
  );
  const llmHeight = 5;
  const tokenHeight = 7;
  const commandHeight = 3;
  const diffHeight = Math.max(
    8,
    innerHeight - llmHeight - tokenHeight - commandHeight,
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
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [expandedLlmIds, setExpandedLlmIds] = useState<Set<string>>(new Set());
  const [lastToolId, setLastToolId] = useState<string | null>(null);
  const [lastLlmId, setLastLlmId] = useState<string | null>(null);
  const [workflowMaxOffset, setWorkflowMaxOffset] = useState(0);
  const [summaryMaxOffset, setSummaryMaxOffset] = useState(0);
  const [expandedStates, setExpandedStates] = useState<Set<AgentState>>(
    new Set(["init"]),
  );
  const [stateFocus, setStateFocus] = useState<AgentState>("init");
  const [tick, setTick] = useState(0);
  const [activePanel, setActivePanel] = useState<"left" | "right">("left");
  const [errorCount, setErrorCount] = useState(0);

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
          setExpandedStates((current) => {
            const next = new Set(current);
            next.add(event.state);
            return next;
          });
          setStateFocus(event.state);
        }
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
        if (event.type === "tool_result") {
          setLastToolId(`${event.tool}-${event.timestamp}`);
          if (!event.success) setErrorCount((current) => current + 1);
        }
        if (event.type === "error") setErrorCount((current) => current + 1);

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
    if (key.tab) {
      setActivePanel((current) => (current === "left" ? "right" : "left"));
      return;
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
      } else if (activePanel === "left" && lastLlmId) {
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
    if (key.backspace) {
      setCommand((current) => current.slice(0, -1));
      return;
    }

    if (command.length === 0) {
      if (activePanel === "left") {
        const visible = getVisibleStates(snapshot.state, stateLog);
        if (input === "[") {
          setStateFocus((current) => {
            const index = visible.indexOf(current);
            return visible[Math.max(0, index - 1)] ?? current;
          });
          return;
        }
        if (input === "]") {
          setStateFocus((current) => {
            const index = visible.indexOf(current);
            return visible[Math.min(visible.length - 1, index + 1)] ?? current;
          });
          return;
        }
        if (input === "e") {
          setExpandedStates((current) => {
            const next = new Set(current);
            if (next.has(stateFocus)) next.delete(stateFocus);
            else next.add(stateFocus);
            return next;
          });
          return;
        }
        if (key.upArrow || key.downArrow) {
          const delta = key.upArrow ? -1 : 1;
          setWorkflowOffset((current) =>
            Math.min(workflowMaxOffset, Math.max(0, current + delta)),
          );
          return;
        }
        if (key.pageUp || key.pageDown) {
          const delta = key.pageUp ? -1 : 1;
          setSummaryOffset((current) =>
            Math.min(summaryMaxOffset, Math.max(0, current + delta)),
          );
          return;
        }
        if (input === "x" && lastToolId) {
          setExpandedToolIds((current) => {
            const next = new Set(current);
            if (next.has(lastToolId)) next.delete(lastToolId);
            else next.add(lastToolId);
            return next;
          });
          return;
        }
        if (input === "c") {
          setExpandedToolIds(new Set());
          return;
        }
      } else {
        if (key.upArrow || key.downArrow) {
          const delta = key.upArrow ? -1 : 1;
          setDiffOffsets((current) => {
            const next = [...current];
            next[diffFocus] = Math.max(0, (next[diffFocus] ?? 0) + delta);
            return next;
          });
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
      }
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
            title="FSM TOPOLOGY"
            color="cyan"
            height={topologyHeight}
            width={leftWidth - 2}
            focused={activePanel === "left"}
          >
            <TopologyBar
              state={snapshot.state}
              stateLog={stateLog}
              tick={tick}
              width={leftWidth - 6}
            />
          </Panel>
          <Panel
            title="AUTOMATED WORKFLOWS"
            color="cyan"
            height={workflowHeight}
            width={leftWidth - 2}
            focused={activePanel === "left"}
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
              expandedToolIds={expandedToolIds}
              expandedLlmIds={expandedLlmIds}
              expandedStates={expandedStates}
              stateFocus={stateFocus}
              onMaxOffset={setWorkflowMaxOffset}
            />
          </Panel>
          <Panel
            title="FINAL SUMMARY"
            color="green"
            height={summaryHeight}
            width={leftWidth - 2}
            focused={activePanel === "left"}
          >
            <SummaryView
              summary={snapshot.summary ?? ""}
              offset={summaryOffset}
              height={summaryHeight - 3}
              width={leftWidth - 6}
              onMaxOffset={setSummaryMaxOffset}
            />
          </Panel>
        </Box>

        <Box flexDirection="column" width={rightWidth} height={innerHeight}>
          <Panel title="LLM CONTEXT" color="blue" height={llmHeight} width={rightWidth - 2} focused={activePanel === "right"}>
            <Text color="white" wrap="truncate">model: {model} · mode: {mode} · task: {task || "(no task)"}</Text>
            {snapshot.llm ? (
            <Text color="gray" wrap="truncate">
              {cliTruncate(snapshot.llm, rightWidth - 6, { position: "end" })}
              </Text>
            ) : null}
          </Panel>

          <Panel title="TOKEN STATISTICS" color="blue" height={tokenHeight} width={rightWidth - 2} focused={activePanel === "right"}>
            <TokenStats usage={usageTotals} limit={tokenLimit} errorCount={errorCount} />
          </Panel>

          <Panel
            title="FILE MODIFICATION DIFF"
            color="blue"
            height={diffHeight}
            width={rightWidth - 2}
            focused={activePanel === "right"}
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
            focused={activePanel === "right"}
          >
            <Box flexDirection="row">
              <Text color="green">{"> AgentCommand: "}</Text>
              <Text color="white">{command}</Text>
              <Text color="gray">█</Text>
            </Box>
          </Panel>
        </Box>
      </Box>
      <Text color="gray">
        [Tab] Switch Panel · [↑/↓] Workflow · [PgUp/PgDn] Summary · [Enter] Expand
      </Text>
    </Box>
  );
}

function Panel({
  title,
  color,
  height,
  width,
  focused,
  children,
}: {
  title: string;
  color: string;
  height?: number;
  width?: number;
  focused?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box
      borderStyle={focused ? "double" : "round"}
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      marginBottom={0}
      height={height}
      width={width}
      overflowY={height ? "hidden" : undefined}
      overflowX="hidden"
      flexShrink={0}
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
  expandedToolIds,
  expandedLlmIds,
  expandedStates,
  stateFocus,
  onMaxOffset,
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
  expandedToolIds: Set<string>;
  expandedLlmIds: Set<string>;
  expandedStates: Set<AgentState>;
  stateFocus: AgentState;
  onMaxOffset: (max: number) => void;
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
  const logical: ColoredLine[] = [
    { text: `Task: ${task || "(no task)"}`, color: "white" },
  ];

  for (const item of visibleStates) {
    const expandedState = expandedStates.has(item);
    logical.push({
      text: `${expandedState ? "▼" : "▷"} ${item}`,
      color: item === stateFocus ? "green" : "cyan",
    });
    const entries = stateLog[item];
    if (!expandedState) {
      if (entries.length > 0) {
        logical.push({
          text: `    └─ ${entries.length} events`,
          color: "gray",
          wrap: false,
        });
      }
      continue;
    }
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      const isLast = entryIndex === entries.length - 1;
      const isExpanded = entry.id && expandedToolIds.has(entry.id);
      const isLlmExpanded = entry.id && expandedLlmIds.has(entry.id);
      let entryText = entry.text;
      if (entry.kind === "tool_start" && entry.args) {
        entryText = `${entry.text} (${entry.args.replace(/\s+/g, " ")})`;
      } else if (entry.kind === "llm") {
        const content = entry.fullText ?? "";
        const needsExpand = content.includes("\n") || content.length > width;
        entryText = isLlmExpanded
          ? content
          : needsExpand
            ? `LLM Output: "${truncateText(
                content.split("\n")[0],
                width - 18,
              )}" (按 Enter 查看完整文本)`
            : `LLM Output: "${content}"`;
      }
      logical.push({
        text: `    ${isLast ? "└─" : "├─"} ${truncateText(entryText, width)}`,
        color: entry.color ?? "gray",
        wrap: false,
      });
      if (entry.kind === "tool_result" && !isExpanded && entry.outputPreview) {
        logical.push({
          text: `      └─ ${truncateText(entry.outputPreview.split("\n")[0], width)}`,
          color: "gray",
          wrap: false,
        });
      }
      if (entry.kind === "tool_result" && isExpanded && entry.fullText) {
        logical.push({ text: entry.fullText, color: "white", wrap: true });
      }
    }
  }

  const physicalCount = logical.flatMap((line) =>
    wrapAnsi(line.text, width, { hard: true }).split("\n"),
  ).length;
  const maxOffset = Math.max(0, physicalCount - height);
  useEffect(() => {
    onMaxOffset(maxOffset);
  }, [maxOffset, onMaxOffset]);

  return (
    <StringScrollable
      lines={logical}
      height={height}
      offset={workflowOffset}
      width={width}
    />
  );
}

function TopologyBar({
  state,
  stateLog,
  tick,
  width,
}: {
  state: AgentState;
  stateLog: Record<AgentState, ActivityItem[]>;
  tick: number;
  width: number;
}) {
  const failedVerify = stateLog.verify.some((entry) =>
    entry.text.includes("✗ tests failed"),
  );
  const lines = renderTopologyLines(state, failedVerify, tick);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={line.color} wrap="truncate">
          {cliTruncate(line.text, width, { position: "end" })}
        </Text>
      ))}
    </Box>
  );
}

function renderTopologyLines(
  state: AgentState,
  failedVerify: boolean,
  tick: number,
): ColoredLine[] {
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
  const topology = order
    .map((item, index) => {
      const reached = stateIndex >= index;
      const active = item === state;
      const skipped = !reached;
      const arrow = index < order.length - 1 ? " ─▶ " : "";
      if (active) return `[● ${item.toUpperCase()}]${arrow}`;
      if (reached) return `[✓ ${item}]${arrow}`;
      return `[  ${item}]${arrow}`;
    })
    .join("");
  const nodes: ColoredLine[] = [{ text: topology, color: "cyan" }];
  if (failedVerify) {
    nodes.push({
      text: `verify --(fail)--▶ executor${blink ? " ⚡" : ""}`,
      color: "yellow",
    });
  }
  nodes.push({ text: "rollback ─▶ planner", color: "gray" });
  return nodes;
}

function SummaryView({
  summary,
  offset,
  height,
  width,
  onMaxOffset,
}: {
  summary: string;
  offset: number;
  height: number;
  width: number;
  onMaxOffset: (max: number) => void;
}) {
  const rawLines = summary.trim()
    ? summary.split("\n")
    : ["Waiting for final summary..."];
  const coloredLines: ColoredLine[] = rawLines.map((line) => ({
    text: line,
    color: summary.trim() ? "white" : "gray",
  }));
  const physicalCount = coloredLines.flatMap((line) =>
    wrapAnsi(line.text, width, { hard: true }).split("\n"),
  ).length;
  const maxOffset = Math.max(0, physicalCount - height);
  useEffect(() => {
    onMaxOffset(maxOffset);
  }, [maxOffset, onMaxOffset]);
  return (
    <StringScrollable
      lines={coloredLines}
      height={height}
      offset={offset}
      width={width}
    />
  );
}

function StringScrollable({
  lines,
  height,
  offset,
  width,
}: {
  lines: ColoredLine[];
  height: number;
  offset: number;
  width: number;
}) {
  const physical = lines.flatMap((line) => {
    if (line.wrap === false) {
      const single = line.text.replace(/\s+/g, " ");
      return [{ text: cliTruncate(single, width, { position: "end" }), color: line.color }];
    }
    return wrapAnsi(line.text, width, { hard: true })
      .split("\n")
      .map((text) => ({ text, color: line.color }));
  });
  const maxOffset = Math.max(0, physical.length - height);
  const clamped = Math.min(offset, maxOffset);
  const visible = physical.slice(clamped, clamped + height);

  return (
    <Box flexDirection="column">
      {visible.map((line, index) => (
        <Text key={index} color={line.color} wrap="truncate">
          {line.text}
        </Text>
      ))}
      <Text color="gray">
        {clamped + 1}-{Math.min(physical.length, clamped + height)} /{" "}
        {physical.length}
      </Text>
    </Box>
  );
}

function TokenStats({
  usage,
  limit,
  errorCount,
}: {
  usage: LLMUsage;
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
      <Text color="white">
        cache hit {cacheHitRate} · err signatures {errorCount}/3
      </Text>
      <Text color="yellow">est cost ${cost.toFixed(4)}</Text>
      <Text color="gray">remaining {remaining} / {limit}</Text>
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
  const logical: ColoredLine[] = diffs.flatMap((diff, index) => {
    const expanded = expandedDiffs.has(index);
    const header = `${expanded ? "[-] " : "[+] "}${diff.path}`;
    if (!expanded) return [{ text: header, color: "cyan" }];
    return [
      { text: header, color: "cyan" },
      ...diff.oldText.split("\n").map((line) => ({ text: `- ${line}`, color: "red" })),
      ...diff.newText.split("\n").map((line) => ({ text: `+ ${line}`, color: "green" })),
    ];
  });
  const offset = offsets[focus] ?? 0;
  return (
    <StringScrollable
      lines={logical}
      height={height}
      offset={offset}
      width={width}
    />
  );
}

function summarizeActivity(event: AgentEvent): ActivityItem | null {
  switch (event.type) {
    case "llm":
      if (!cleanLlmText(event.content) || cleanLlmText(event.content) === "(tool calls)") {
        return null;
      }
      return {
        kind: "llm",
        id: `llm-${event.timestamp}`,
        fullText: cleanLlmText(event.content),
        text: "LLM Output",
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
        text: `${event.tool} ${event.success ? "ok" : "failed"}`,
        fullText: `${event.tool} ${event.success ? "ok" : "failed"}:\n${
          event.output || event.error || ""
        }`,
        tool: event.tool,
        outputPreview: summarizeToolResult(event),
        errorSignature: event.error,
        color: event.success ? "green" : "red",
      };
    case "verification":
      return {
        kind: "verification",
        text: event.passed ? "✓ passed" : "✗ failed",
        color: event.passed ? "green" : "red",
      };
    case "checklist":
      return {
        kind: "checklist",
        text: `checklist: ${event.items.map((item) => item.id).join(" → ")}`,
        color: "cyan",
      };
    case "rollback":
      return {
        kind: "rollback",
        text: `rollback: ${event.message}`,
        color: event.success ? "yellow" : "red",
      };
    case "error":
      return {
        kind: "error",
        text: `error: ${event.message}`,
        color: "red",
      };
    case "diagnostic":
    case "checkpoint":
    case "finish":
    case "state":
      return null;
  }
}

function summarizeToolResult(
  event: Extract<AgentEvent, { type: "tool_result" }>,
): string {
  const raw = event.output ?? event.error ?? "";
  const lines = raw.trim().split("\n").filter(Boolean);
  if (event.tool === "read_file") {
    const first = lines[0] ?? "";
    return `${lines.length} lines `;
  }
  if (event.tool === "list_dir") {
    return `${lines.length} entries · ${lines.slice(0, 3).join(", ")}`;
  }
  if (event.tool === "bash") {
    return event.success ? "exit 0" : "";
  }
  return lines[0] ?? "";
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

function getVisibleStates(
  state: AgentState,
  stateLog: Record<AgentState, ActivityItem[]>,
): AgentState[] {
  const order: AgentState[] = [
    "init",
    "planner",
    "executor",
    "verify",
    "commit",
    "rollback",
    "finish",
  ];
  return order.filter((item) => item === state || stateLog[item].length > 0);
}

function formatToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => {
      let text = typeof value === "string" ? value : JSON.stringify(value);
      if (key === "command") {
        text = text.replace(/\s+/g, " ").trim();
        text = cliTruncate(text, 90, { position: "end" });
      }
      return `${key}: ${text}`;
    })
    .join(", ");
}
