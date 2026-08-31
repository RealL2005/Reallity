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
  usage?: LLMUsage;
  events: number;
  running: boolean;
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

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 2_200);
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
          } else if (event.type === "tool_result") {
            next.tool = `${event.tool} ${event.success ? "ok" : "failed"}`;
            next.toolOutput = event.output;
            next.toolError = event.error;
          } else if (event.type === "verification") {
            next.tool = event.passed ? "Tests passed" : "Tests failed";
          } else if (event.type === "error") {
            next.tool = event.message;
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
      <Box flexDirection="column" width="46%">
        <Text>{renderBanner("Reallity", "Small")}</Text>
        <Panel title="AUTOMATED WORKFLOWS" color="cyan">
          <WorkflowView state={snapshot.state} activity={activity} />
        </Panel>
        <Panel title="AGENT FSM STATUS" color="cyan">
          <FsmView state={snapshot.state} />
        </Panel>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <Panel title="LLM CONTEXT" color="blue">
          <Text color="white">model: {model}</Text>
          <Text color="white">mode: {mode}</Text>
          <Text color="white">task: {task || "(no task)"}</Text>
          {snapshot.llm ? (
            <Text color="gray" wrap="truncate">
              {truncateText(snapshot.llm, contentWidth - 6)}
            </Text>
          ) : null}
        </Panel>

        <Panel title="TOKEN STATISTICS" color="blue">
          <TokenStats usage={usageTotals} limit={tokenLimit} />
        </Panel>

        <Panel title="FILE MODIFICATION DIFF" color="blue">
          <DiffViewer
            diffs={diffs}
            expandedDiffs={expandedDiffs}
            focus={diffFocus}
            offsets={diffOffsets}
            width={contentWidth - 6}
          />
        </Panel>

        <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text color="green">{" > AgentCommand: "}</Text>
          <Text color="white">{command}</Text>
          <Text color="gray">█</Text>
        </Box>
      </Box>
    </Box>
  );
}

function Panel({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      marginY={1}
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
  activity,
}: {
  state: AgentState;
  activity: ActivityItem[];
}) {
  const steps: WorkflowStep[] = [
    { label: "Plan", status: workflowStatus(state, "planner", "executor") },
    {
      label: "Analyze",
      status: workflowStatus(state, "executor", "verify"),
    },
    {
      label: "Generate",
      status: workflowStatus(state, "verify", "commit"),
    },
    {
      label: "Execute",
      status: workflowStatus(state, "commit", "finish"),
    },
    {
      label: "Done",
      status: state === "finish" ? "done" : "pending",
    },
  ];

  return (
    <Box flexDirection="column">
      {steps.map((step) => (
        <Text key={step.label} color={statusColor(step.status)}>
          {step.status === "done"
            ? "✓"
            : step.status === "active"
              ? ">"
              : " "}{" "}
          {step.label}
        </Text>
      ))}
      <Text bold color="gray">Activity</Text>
      {activity.slice(-12).map((item, index) => (
        <Text key={index} color={item.color ?? "white"} wrap="truncate">
          {item.text}
        </Text>
      ))}
    </Box>
  );
}

function FsmView({ state }: { state: AgentState }) {
  const diagram = [
    "init ─▶ planner ─▶ executor ─▶ verify",
    "                    ▲         │",
    "                    └─ rollback ◀┘",
    "verify ─▶ commit ─▶ finish",
  ];
  return (
    <Box flexDirection="column">
      {diagram.map((line, index) => (
        <Text key={index} color={index === 0 ? "cyan" : "gray"}>
          {line}
        </Text>
      ))}
      <Text color="yellow">current: {state}</Text>
    </Box>
  );
}

function TokenStats({ usage, limit }: { usage: LLMUsage; limit: number }) {
  const cost = (usage.promptTokens / 1_000_000) * 3 + (usage.completionTokens / 1_000_000) * 15;
  const remaining = Math.max(0, limit - usage.totalTokens);
  return (
    <Box flexDirection="column">
      <Text color="white">prompt: {usage.promptTokens}</Text>
      <Text color="white">completion: {usage.completionTokens}</Text>
      <Text color="white">total: {usage.totalTokens}</Text>
      <Text color="yellow">est cost: ${cost.toFixed(4)}</Text>
      <Text color="gray">remaining: {remaining} / {limit}</Text>
    </Box>
  );
}

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
    return <Text color="gray">No file modifications yet</Text>;
  }

  return (
    <Box flexDirection="column">
      {diffs.map((diff, index) => {
        const expanded = expandedDiffs.has(index);
        const lines = [
          ...diff.oldText.split("\n").map((line) => ({ text: `- ${line}`, color: "red" })),
          ...diff.newText.split("\n").map((line) => ({ text: `+ ${line}`, color: "green" })),
        ];
        const offset = Math.min(offsets[index] ?? 0, Math.max(0, lines.length - 6));
        const visible = lines.slice(offset, offset + 6);
        return (
          <Box flexDirection="column" key={`${diff.path}-${index}`}>
            <Text color={index === focus ? "cyan" : "gray"}>
              {expanded ? "[-] " : "[+] "}
              {diff.path} · {diff.oldText.split("\n").length + diff.newText.split("\n").length} lines
            </Text>
            {expanded ? (
              <Box flexDirection="column">
                {visible.map((line, lineIndex) => (
                  <Text key={lineIndex} color={line.color} wrap="truncate">
                    {truncateText(line.text, width)}
                  </Text>
                ))}
                <Text color="gray">
                  {offset + 1}-{Math.min(lines.length, offset + 6)} / {lines.length}
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

function fsmStatus(state: AgentState): string {
  if (state === "finish") return "DONE";
  if (state === "rollback") return "RETRYING";
  if (state === "init") return "IDLE";
  return "WORKING";
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
        text: `LLM: ${truncateText(cleanLlmText(event.content), 70)}`,
        color: "white",
      };
    case "tool_start":
      return { text: `▶ ${event.tool}`, color: "yellow" };
    case "tool_result":
      return {
        text: `${event.tool} ${event.success ? "ok" : "failed"}`,
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
    case "error":
      return { text: `error: ${event.message}`, color: "red" };
    case "finish":
      return { text: "finished", color: "green" };
  }
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
