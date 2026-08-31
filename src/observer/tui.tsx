import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput } from "ink";
import { renderBanner } from "../banner.ts";
import type { EventBus } from "./events.ts";
import type { AgentState } from "../fsm/types.ts";
import type { LLMUsage } from "../llm/types.ts";

interface TuiAppProps {
  bus: EventBus;
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
  diff?: DiffView;
  usage?: LLMUsage;
  events: number;
  running: boolean;
}

function TuiApp({ bus }: TuiAppProps) {
  const [showSplash, setShowSplash] = useState(true);
  const [snapshot, setSnapshot] = useState<TuiSnapshot>({
    state: "init",
    llm: "",
    tool: "",
    events: 0,
    running: true,
  });
  const [focused, setFocused] = useState<"llm" | "tool">("llm");
  const [llmOffset, setLlmOffset] = useState(0);
  const [toolOffset, setToolOffset] = useState(0);

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
            next.diff = undefined;
          } else if (event.type === "tool_result") {
            next.tool = `${event.tool} ${event.success ? "ok" : "failed"}`;
            next.toolOutput = event.output;
            next.toolError = event.error;
            next.diff = event.diff;
          } else if (event.type === "verification") {
            next.tool = event.passed ? "Tests passed" : "Tests failed";
          } else if (event.type === "error") {
            next.tool = event.message;
          }

          return next;
        });
      }),
    [bus],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 2_200);
    return () => clearTimeout(timer);
  }, []);

  useInput((_input, key) => {
    if (key.tab) {
      setFocused((current) => (current === "llm" ? "tool" : "llm"));
      return;
    }

    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      if (focused === "llm") {
        setLlmOffset((current) => Math.max(0, current + delta));
      } else {
        setToolOffset((current) => Math.max(0, current + delta));
      }
    }
  });

  const llmLines = snapshot.llm
    ? renderMarkdownLineNodes(snapshot.llm)
    : [<Text key="llm-empty">Waiting for planner...</Text>];
  const toolLines =
    snapshot.toolOutput || snapshot.toolError
      ? renderToolLines(snapshot)
      : [<Text key="tool-empty">No tool activity yet</Text>];

  if (showSplash) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{renderBanner("Reallity")}</Text>
        <Text color="gray">Starting Reallity...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={stateColor(snapshot.state)}>
        Reallity
      </Text>
      <Text color={stateColor(snapshot.state)}>
        state: {snapshot.state}
        {snapshot.running ? " • running" : " • done"}
      </Text>

      <Panel
        title="LLM"
        lines={llmLines}
        height={10}
        focused={focused === "llm"}
        offset={llmOffset}
        color={stateColor(snapshot.state)}
      />

      <Panel
        title={snapshot.currentTool ? `Tool: ${snapshot.currentTool}` : "Tool"}
        lines={toolLines}
        height={8}
        focused={focused === "tool"}
        offset={toolOffset}
        color={stateColor(snapshot.state)}
      />

      {snapshot.diff ? (
        <Box borderStyle="round" borderColor={stateColor(snapshot.state)} flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="white">
            Diff: {snapshot.diff.path}
          </Text>
          <Text color="red" wrap="truncate">
            - {snapshot.diff.oldText}
          </Text>
          <Text color="green" wrap="truncate">
            + {snapshot.diff.newText}
          </Text>
        </Box>
      ) : null}

      {snapshot.usage ? (
        <Text color="gray">
          tokens {snapshot.usage.totalTokens} / prompt{" "}
          {snapshot.usage.promptTokens} / completion{" "}
          {snapshot.usage.completionTokens} / cache hit{" "}
          {snapshot.usage.promptCacheHitTokens}
        </Text>
      ) : null}

      <Text color="gray">events: {snapshot.events}</Text>
      <Text color="gray">Tab to switch panel · ↑/↓ to scroll</Text>
    </Box>
  );
}

interface PanelProps {
  title: string;
  lines: React.ReactNode[];
  height: number;
  focused: boolean;
  offset: number;
  color: string;
}

function Panel({
  title,
  lines,
  height,
  focused,
  offset,
  color,
}: PanelProps) {
  const maxOffset = Math.max(0, lines.length - height);
  const clampedOffset = Math.min(offset, maxOffset);
  const visible = lines.slice(clampedOffset, clampedOffset + height);
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
      : Math.floor((clampedOffset / maxOffset) * (height - thumbHeight));

  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="white">
        {title}
      </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          {visible}
        </Box>
        <Box flexDirection="column" width={1}>
          {Array.from({ length: height }, (_, index) => (
            <Text key={`scroll-${index}`} color={focused ? "green" : "gray"}>
              {index >= thumbTop && index < thumbTop + thumbHeight
                ? "█"
                : "│"}
            </Text>
          ))}
        </Box>
      </Box>
      <Text color={focused ? "green" : "gray"}>
        {clampedOffset + 1}-{Math.min(lines.length, clampedOffset + height)} /{" "}
        {lines.length}
      </Text>
    </Box>
  );
}

export function startTUI(bus: EventBus): () => void {
  const instance = render(<TuiApp bus={bus} />);
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
  if (lines.length <= maxLines) {
    return content;
  }

  const omitted = lines.length - maxLines;
  return [
    `... [${omitted} earlier lines hidden]`,
    ...lines.slice(-maxLines),
  ].join("\n");
}

function formatToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}: ${text}`;
  });
  return entries.join(" | ");
}

function renderMarkdownLineNodes(content: string): React.ReactNode[] {
  const lines = content.split("\n");
  const nodes: React.ReactNode[] = [];
  let inCodeBlock = false;
  let tableLines: string[] = [];

  const flushTable = () => {
    if (tableLines.length === 0) {
      return;
    }
    for (const [tableIndex, tableLine] of formatMarkdownTable(
      tableLines,
    ).entries()) {
      nodes.push(
        <Text key={`table-${tableIndex}`} wrap="truncate" color="gray">
          {tableLine}
        </Text>,
      );
    }
    tableLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      flushTable();
      nodes.push(
        <Text key={`code-${index}`} color="yellow" wrap="truncate">
          {line}
        </Text>,
      );
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableLines.push(line);
      continue;
    }

    flushTable();

    if (/^#{1,6}\s+/.test(line)) {
      nodes.push(
        <Text key={`h-${index}`} bold color="cyan" wrap="truncate">
          {cleanInlineMarkdown(line.replace(/^#{1,6}\s+/, ""))}
        </Text>,
      );
      continue;
    }

    nodes.push(
      <Text key={`line-${index}`} wrap="truncate">
        {cleanInlineMarkdown(line)}
      </Text>,
    );
  }

  flushTable();
  return nodes;
}

function renderToolLines(snapshot: TuiSnapshot): React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  if (snapshot.toolArgs) {
    lines.push(
      <Text key="tool-args" color="gray" wrap="truncate">
        {formatToolArgs(snapshot.toolArgs)}
      </Text>,
    );
  }
  if (snapshot.toolOutput) {
    lines.push(
      ...snapshot.toolOutput.split("\n").map((line, index) => (
        <Text key={`out-${index}`} wrap="truncate">
          {line}
        </Text>
      )),
    );
  }
  if (snapshot.toolError) {
    lines.push(
      ...snapshot.toolError.split("\n").map((line, index) => (
        <Text key={`err-${index}`} color="red" wrap="truncate">
          {line}
        </Text>
      )),
    );
  }
  return lines;
}

function cleanInlineMarkdown(content: string): string {
  return content
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*>+\s?/, "");
}

export function formatMarkdownTable(lines: string[]): string[] {
  const rows = lines
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, ""))
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .split("|")
        .map((cell) => cleanInlineMarkdown(cell.trim())),
    )
    .filter(
      (row) => !row.every((cell) => /^:?-+:?$/.test(cell)),
    );

  if (rows.length === 0) {
    return [];
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(
      1,
      ...rows.map((row) => (row[column] ?? "").length),
    ),
  );

  const formatRow = (row: string[]) =>
    `| ${row
      .map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 1))
      .join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;

  return [
    formatRow(rows[0]),
    separator,
    ...rows.slice(1).map((row) => formatRow(row)),
  ];
}
