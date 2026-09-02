import React, { useEffect, useMemo, useRef, useState } from "react";
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
  resumed?: boolean;
  splashMs?: number;
  onAsk?: (text: string) => void;
  onSave?: (sessionPath?: string) => void;
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
    | "error"
    | "notice";
  tool?: string;
  args?: string;
  outputPreview?: string;
  errorSignature?: string;
  success?: boolean;
  items?: string[];
}

interface ColoredLine {
  text: string;
  color?: string;
  wrap?: boolean;
}

type PanelId =
  | "topology"
  | "conversation"
  | "workflow"
  | "summary"
  | "llm"
  | "token"
  | "diff";

const PANEL_ORDER: PanelId[] = [
  "topology",
  "conversation",
  "workflow",
  "summary",
  "llm",
  "token",
  "diff",
];

export interface TuiHeights {
  bannerHeight: number;
  inputHeight: number;
  innerHeight: number;
  topologyHeight: number;
  conversationHeight: number;
  summaryHeight: number;
  workflowHeight: number;
  llmHeight: number;
  tokenHeight: number;
  diffHeight: number;
}

export function computeHeights(rows: number): TuiHeights {
  const terminalHeight = Math.max(14, rows - 2);
  const bannerHeight =
    terminalHeight >= 30 ? 5 : terminalHeight >= 18 ? 1 : 0;
  const inputHeight = terminalHeight >= 18 ? 4 : 3;
  const innerHeight = Math.max(
    8,
    terminalHeight - bannerHeight - inputHeight,
  );

  // 左侧优先级：workflow(主面板) > summary(5) > conversation > topology(装饰)
  const topologyHeight = innerHeight >= 20 ? 4 : 0;
  const conversationHeight = innerHeight >= 22 ? 6 : 4;
  const summaryHeight = Math.min(
    5,
    Math.max(3, Math.floor(innerHeight / 3)),
  );
  const workflowHeight = Math.max(
    4,
    innerHeight - topologyHeight - conversationHeight - summaryHeight,
  );

  // 右侧：llm(元数据2行+内容) 与 token(4行内容) 按需给足，diff 吃余量
  const llmHeight =
    innerHeight >= 20 ? 8 : innerHeight >= 16 ? 6 : 4;
  const tokenHeight =
    innerHeight >= 16 ? 7 : 0;
  const diffHeight = Math.max(4, innerHeight - llmHeight - tokenHeight);
  return {
    bannerHeight,
    inputHeight,
    innerHeight,
    topologyHeight,
    conversationHeight,
    summaryHeight,
    workflowHeight,
    llmHeight,
    tokenHeight,
    diffHeight,
  };
}

export function TuiApp({
  bus,
  model = "gpt-4.1-mini",
  mode = "tui",
  task = "",
  tokenLimit = 200_000,
  workspaceRoot = process.cwd(),
  resumed = false,
  splashMs = 2_200,
  onAsk,
  onSave,
}: TuiAppProps) {
  const { stdout } = useStdout();
  const contentWidth = Math.max(40, stdout.columns - 2);
  const leftWidth = Math.floor(contentWidth / 2);
  const rightWidth = contentWidth - leftWidth;
  const terminalHeight = Math.max(16, stdout.rows - 2);
  const {
    bannerHeight,
    inputHeight,
    innerHeight,
    topologyHeight,
    conversationHeight,
    summaryHeight,
    workflowHeight,
    llmHeight,
    tokenHeight,
    diffHeight,
  } = computeHeights(stdout.rows);
  const [showSplash, setShowSplash] = useState(true);
  const [snapshot, setSnapshot] = useState<TuiSnapshot>({
    state: "init",
    llm: "",
    events: 0,
    running: false,
  });
  const [usageTotals, setUsageTotals] = useState<LLMUsage>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
  });
  const [currentUsage, setCurrentUsage] = useState({
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
  const [diffMaxOffsets, setDiffMaxOffsets] = useState<number[]>([]);
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
  const [llmOffset, setLlmOffset] = useState(0);
  const [workflowOffset, setWorkflowOffset] = useState(0);
  const [conversationOffset, setConversationOffset] = useState(0);
  const [bannerPos, setBannerPos] = useState({ x: 0, dir: 1 as 1 | -1 });
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [expandedLlmIds, setExpandedLlmIds] = useState<Set<string>>(new Set());
  const [lastToolId, setLastToolId] = useState<string | null>(null);
  const [lastLlmId, setLastLlmId] = useState<string | null>(null);
  const [expandedStates, setExpandedStates] = useState<Set<AgentState>>(
    new Set(["init"]),
  );
  const [stateFocus, setStateFocus] = useState<AgentState>("init");
  const [activePanel, setActivePanel] = useState<PanelId>("workflow");
  const [errorCount, setErrorCount] = useState(0);

  const appendActivity = (item: ActivityItem) => {
    setStateLog((current) => {
      const state = currentStateRef.current;
      return { ...current, [state]: [...current[state], item] };
    });
  };

  const resetTaskView = () => {
    setStateLog({
      init: [],
      planner: [],
      executor: [],
      verify: [],
      commit: [],
      rollback: [],
      finish: [],
    });
    setDiffs([]);
    setSnapshot((current) => ({
      ...current,
      summary: "",
      llm: "",
      currentTool: undefined,
      toolError: undefined,
    }));
    setWorkflowOffset(0);
    setConversationOffset(0);
    setSummaryOffset(0);
    setLlmOffset(0);
    setDiffFocus(0);
    setDiffOffsets([]);
    setErrorCount(0);
    setCurrentUsage({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
    });
  };

  const workflowMax = useMemo(() => {
    const physicalCount = countWorkflowLines(
      snapshot.state,
      stateLog,
      expandedStates,
      leftWidth - 6,
    );
    return Math.max(0, physicalCount - Math.max(1, workflowHeight - 4));
  }, [snapshot.state, stateLog, expandedStates, leftWidth, workflowHeight]);

  const summaryMax = useMemo(() => {
    const raw = snapshot.summary?.trim()
      ? snapshot.summary.split("\n")
      : ["Waiting for final summary..."];
    const physicalCount = raw.flatMap((line) =>
      wrapAnsi(line, leftWidth - 6, { hard: true }).split("\n"),
    ).length;
    return Math.max(0, physicalCount - Math.max(1, summaryHeight - 4));
  }, [snapshot.summary, leftWidth, summaryHeight]);

  const llmMax = useMemo(() => {
    const raw = snapshot.llm.trim()
      ? snapshot.llm.split("\n")
      : ["No LLM output yet"];
    const physicalCount = raw.flatMap((line) =>
      wrapAnsi(line, rightWidth - 6, { hard: true }).split("\n"),
    ).length;
    return Math.max(0, physicalCount - Math.max(1, llmHeight - 2));
  }, [snapshot.llm, rightWidth, llmHeight]);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), splashMs);
    return () => clearTimeout(timer);
  }, []);

  useEffect(
    () =>
      bus.subscribe((event) => {
        setSnapshot((current) => {
          const next = {
            ...current,
            events: current.events + 1,
          };

          if (event.type === "state") {
            next.state = event.state;
          } else if (event.type === "session_task_start") {
            next.running = true;
          } else if (event.type === "session_task_end") {
            next.running = false;
          } else if (event.type === "finish") {
            next.running = false;
            next.summary = event.answer || event.message;
          } else if (event.type === "llm") {
            next.llm = cleanLlmText(event.content);
            next.usage = event.usage;
          } else if (event.type === "tool_start") {
            next.currentTool = event.tool;
            next.toolError = undefined;
          } else if (event.type === "tool_result") {
            next.currentTool = event.tool;
            next.toolError = event.error;
          }

          return next;
        });

        if (event.type === "session_task_start") {
          resetTaskView();
        }
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
          setCurrentUsage((current) => ({
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
          if (!event.success && event.code !== "BASH_NONZERO_EXIT") {
            setErrorCount((current) => current + 1);
          }
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
      setActivePanel((current) => {
        const index = PANEL_ORDER.indexOf(current);
        return PANEL_ORDER[(index + 1) % PANEL_ORDER.length];
      });
      return;
    }

    const { leading, hasBreak } = splitLeadingLine(input);
    if (hasBreak || key.return) {
      const text = command + leading;
      if (snapshot.running) {
        setCommand("");
        return;
      }
      if (text.trim()) {
        const parsed = parseCommand(text);
        if (parsed) {
          switch (parsed.type) {
            case "ask":
              onAsk?.(parsed.text);
              break;
            case "run":
              void runCommand(parsed.command, workspaceRoot, appendActivity);
              break;
            case "help":
              appendActivity({
                kind: "notice",
                text: "Commands: /task <text> · /run <cmd> · /bash <cmd> · /save [path] · /clear · /help",
                color: "gray",
              });
              break;
            case "save":
              onSave?.(parsed.path);
              break;
            case "clear":
              resetTaskView();
              break;
            case "unknown":
              appendActivity({
                kind: "notice",
                text: `Unknown command: ${parsed.command} — type /help`,
                color: "gray",
              });
              break;
          }
        }
      } else if (activePanel === "workflow" && lastLlmId) {
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

    if (input.length > 1) {
      // batched plain text without a line break (e.g. paste)
      setCommand((current) => `${current}${input}`);
      return;
    }

    if (isEraseKey(input, key)) {
      setCommand((current) => current.slice(0, -1));
      return;
    }

    if (command.length === 0) {
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        if (activePanel === "summary") {
          setSummaryOffset((current) =>
            Math.min(summaryMax, Math.max(0, current + delta)),
          );
        } else if (activePanel === "diff") {
          const max = diffMaxOffsets[diffFocus] ?? 0;
          setDiffOffsets((current) => {
            const next = [...current];
            next[diffFocus] = Math.min(
              max,
              Math.max(0, (next[diffFocus] ?? 0) + delta),
            );
            return next;
          });
        } else if (activePanel === "llm") {
          setLlmOffset((current) =>
            Math.min(llmMax, Math.max(0, current + delta)),
          );
        } else if (activePanel === "conversation") {
          setConversationOffset((current) =>
            Math.min(conversationMax, Math.max(0, current + delta)),
          );
        } else {
          setWorkflowOffset((current) =>
            Math.min(workflowMax, Math.max(0, current + delta)),
          );
        }
        return;
      }

      if (activePanel === "workflow") {
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
      } else if (activePanel === "diff") {
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

      if (input && !key.ctrl && !key.meta) {
        setCommand(input);
        return;
      }
    }

    if (input && !key.ctrl && !key.meta) {
      setCommand((current) => `${current}${input}`);
    }
  });

  const conversation = useMemo(
    () => buildConversation(bus.history),
    [bus, snapshot.events],
  );

  const conversationMax = useMemo(() => {
    const physicalCount = conversation.length * 2;
    return Math.max(0, physicalCount - Math.max(1, conversationHeight - 4));
  }, [conversation, conversationHeight]);

  const bannerWidth = useMemo(
    () =>
      renderBanner("Reallity", "Small")
        .split("\n")
        .reduce((widest, line) => Math.max(widest, line.length), 0),
    [],
  );
  const maxBannerShift = Math.max(0, contentWidth - bannerWidth - 2);

  useEffect(() => {
    if (!(bannerHeight >= 5) || maxBannerShift <= 0) {
      return;
    }
    const timer = setInterval(() => {
      setBannerPos(({ x, dir }) => {
        const [nextX, nextDir] = bounceStep(x, dir, maxBannerShift);
        return { x: nextX, dir: nextDir };
      });
    }, 120);
    return () => clearInterval(timer);
  }, [bannerHeight, maxBannerShift]);

  if (showSplash) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <GradientBanner text="Reallity" font="Small" />
        <Text color="gray">Starting Reallity...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={contentWidth} height={terminalHeight}>
      {bannerHeight >= 5 ? (
        <Box paddingLeft={bannerPos.x}>
          <GradientBanner text="Reallity" font="Small" />
        </Box>
      ) : bannerHeight === 1 ? (
        <Text bold color="cyan">
          Reallity TUI
        </Text>
      ) : null}
      <Box flexDirection="row" height={innerHeight} width={contentWidth}>
        <Box flexDirection="column" width={leftWidth} height={innerHeight}>
          {topologyHeight > 0 ? (
            <Panel
              title="FSM TOPOLOGY"
              color="cyan"
              height={topologyHeight}
              width={leftWidth - 2}
              focused={activePanel === "topology"}
            >
              <TopologyBar
                state={snapshot.state}
                stateLog={stateLog}
                width={leftWidth - 6}
              />
            </Panel>
          ) : null}
          <Panel
            title="CONVERSATION"
            color="magenta"
            height={conversationHeight}
            width={leftWidth - 2}
            focused={activePanel === "conversation"}
          >
            <ConversationView
              entries={conversation}
              width={leftWidth - 6}
              height={conversationHeight - 3}
              offset={conversationOffset}
            />
          </Panel>
          <Panel
            title="AUTOMATED WORKFLOWS"
            color="cyan"
            height={workflowHeight}
            width={leftWidth - 2}
            focused={activePanel === "workflow"}
          >
            <WorkflowView
              state={snapshot.state}
              task={task}
              stateLog={stateLog}
              workflowOffset={workflowOffset}
              height={workflowHeight - 3}
              width={leftWidth - 6}
              expandedToolIds={expandedToolIds}
              expandedLlmIds={expandedLlmIds}
              expandedStates={expandedStates}
              stateFocus={stateFocus}
            />
          </Panel>
          <Panel
            title="FINAL SUMMARY"
            color="green"
            height={summaryHeight}
            width={leftWidth - 2}
            focused={activePanel === "summary"}
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
          <Panel title="LLM CONTEXT" color="blue" height={llmHeight} width={rightWidth - 2} focused={activePanel === "llm"}>
            <Text color="white" wrap="truncate">
              model: {model} · mode: {mode} · task: {task || "(no task)"}
            </Text>
            <Text color="white" wrap="truncate">
              workspace: {workspaceRoot || "(default)"}
              {resumed ? " · resumed" : ""}
            </Text>
            <LlmContextView
              content={snapshot.llm}
              expanded
              width={rightWidth - 6}
              height={Math.max(1, llmHeight - 5)}
              offset={llmOffset}
            />
          </Panel>

          {tokenHeight > 0 ? (
            <Panel title="TOKEN STATISTICS" color="blue" height={tokenHeight} width={rightWidth - 2} focused={activePanel === "token"}>
              <TokenStats usage={usageTotals} current={currentUsage} limit={tokenLimit} errorCount={errorCount} />
            </Panel>
          ) : null}

          <Panel
            title="FILE MODIFICATION DIFF"
            color="blue"
            height={diffHeight}
            width={rightWidth - 2}
            focused={activePanel === "diff"}
          >
            <DiffViewer
              diffs={diffs}
              expandedDiffs={expandedDiffs}
              focus={diffFocus}
              offsets={diffOffsets}
              width={rightWidth - 6}
              height={diffHeight - 3}
              onMaxOffsets={setDiffMaxOffsets}
            />
          </Panel>

        </Box>
      </Box>
      <Box
        flexDirection="column"
        width={contentWidth}
        height={inputHeight}
        borderStyle="round"
        borderColor={snapshot.running ? "yellow" : "green"}
      >
        <Box flexDirection="row">
          <Text bold color={snapshot.running ? "yellow" : "green"}>
            {"> "}
          </Text>
          <Text color="white" bold wrap="truncate">
            {command}
          </Text>
          {snapshot.running ? (
            <Text color="yellow">⏳</Text>
          ) : (
            <Text color="gray">█</Text>
          )}
        </Box>
        {inputHeight >= 4 ? (
          <Text color="gray" wrap="truncate">
            {snapshot.running
              ? "agent 运行中…"
              : "[Enter] 发送 · [Tab] 面板 · /task /run /help /save /clear"}
          </Text>
        ) : null}
      </Box>
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

function LlmContextView({
  content,
  expanded,
  width,
  height,
  offset,
}: {
  content: string;
  expanded: boolean;
  width: number;
  height: number;
  offset: number;
}) {
  const raw = content.trim() ? content : "No LLM output yet";
  const needsExpand = raw.includes("\n") || raw.length > width;
  if (!expanded) {
    return (
      <Text color="gray" wrap="truncate">
        {cliTruncate(raw.split("\n")[0], width, { position: "end" })}
        {needsExpand ? "  (Enter 展开)" : ""}
      </Text>
    );
  }
  const lines = raw.split("\n").map((text) => ({ text, color: "white" }));
  return <StringScrollable lines={lines} height={height} offset={offset} width={width} />;
}

function GradientBanner({
  text,
  font,
}: {
  text: string;
  font: "Small" | "Standard";
}) {
  const banner = renderBanner(text, font);
  const lines = banner.split("\n").filter((line) => line.length > 0);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={gradientHex(index, lines.length)}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function gradientHex(index: number, total: number): string {
  const ratio = total <= 1 ? 0 : index / (total - 1);
  const hue = 185 + ratio * 95;
  const lightness = 55 + ratio * 18;
  return hslToHex(hue, 85, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function buildWorkflowLines({
  state,
  task,
  stateLog,
  expandedStates,
  expandedToolIds,
  expandedLlmIds,
  width,
}: {
  state: AgentState;
  task: string;
  stateLog: Record<AgentState, ActivityItem[]>;
  expandedStates: Set<AgentState>;
  expandedToolIds: Set<string>;
  expandedLlmIds: Set<string>;
  width: number;
}): ColoredLine[] {
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
  const logical: ColoredLine[] = [
    { text: `Task: ${task || "(no task)"}`, color: "white" },
  ];

  for (const item of visibleStates) {
    const expandedState = expandedStates.has(item);
    logical.push({
      text: `${expandedState ? "▼" : "▷"} ${item}`,
      color: item === state ? "green" : "cyan",
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
      if (entry.kind === "checklist" && entry.items && entry.items.length > 0) {
        logical.push({
          text: `    ${isLast ? "└─" : "├─"} ${entry.text}`,
          color: entry.color ?? "cyan",
          wrap: false,
        });
        for (const item of entry.items) {
          logical.push({
            text: `        - [ ] ${item}`,
            color: "white",
            wrap: true,
          });
        }
        continue;
      }
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

  return logical;
}

function WorkflowView({
  state,
  task,
  stateLog,
  workflowOffset,
  height,
  width,
  expandedToolIds,
  expandedLlmIds,
  expandedStates,
  stateFocus,
}: {
  state: AgentState;
  task: string;
  stateLog: Record<AgentState, ActivityItem[]>;
  workflowOffset: number;
  height: number;
  width: number;
  expandedToolIds: Set<string>;
  expandedLlmIds: Set<string>;
  expandedStates: Set<AgentState>;
  stateFocus: AgentState;
}) {
  const logical = buildWorkflowLines({
    state,
    task,
    stateLog,
    expandedStates,
    expandedToolIds,
    expandedLlmIds,
    width,
  });

  return (
    <StringScrollable
      lines={logical}
      height={height}
      offset={workflowOffset}
      width={width}
    />
  );
}

function ConversationView({
  entries,
  width,
  height,
  offset,
}: {
  entries: ConversationEntry[];
  width: number;
  height: number;
  offset: number;
}) {
  if (entries.length === 0) {
    return (
      <Text color="gray" wrap="truncate">
        No conversation yet — type a message below.
      </Text>
    );
  }
  const lines: ColoredLine[] = entries.flatMap((entry) => [
    {
      text: `You: ${truncateText(entry.task, width)}`,
      color: "cyan",
      wrap: false,
    },
    {
      text: `Agent: ${truncateText(entry.answer, width)}`,
      color: entry.success ? "green" : "red",
      wrap: false,
    },
  ]);
  return (
    <StringScrollable
      lines={lines}
      height={height}
      offset={offset}
      width={width}
    />
  );
}

function TopologyBar({
  state,
  stateLog,
  width,
}: {
  state: AgentState;
  stateLog: Record<AgentState, ActivityItem[]>;
  width: number;
}) {
  const failedVerify = stateLog.verify.some((entry) =>
    entry.kind === "verification" && entry.success === false,
  );
  const lines = renderTopologyLines(state, failedVerify);
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
      text: "verify -(fail)--▶ executor ⚡",
      color: "yellow",
    });
  }
  if (state === "rollback") {
    nodes.push({
      text: "[● ROLLBACK] ─▶ planner",
      color: "green",
    });
  }
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
  const coloredLines: ColoredLine[] = rawLines.map((line) => ({
    text: line,
    color: summary.trim() ? "white" : "gray",
  }));
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
  // 高度足够时留 1 行给页码指示器；高度 <=1 时只显示内容行
  const showIndicator = height >= 2;
  const contentHeight = showIndicator ? Math.max(1, height - 1) : Math.max(1, height);

  const physical = lines.flatMap((line) => {
    if (line.wrap === false) {
      const single = line.text.replace(/\s+/g, " ");
      return [{ text: cliTruncate(single, width, { position: "end" }), color: line.color }];
    }
    return wrapAnsi(line.text, width, { hard: true })
      .split("\n")
      .map((text) => ({ text, color: line.color }));
  });

  const maxOffset = Math.max(0, physical.length - contentHeight);
  const clamped = Math.min(offset, maxOffset);
  const visible = physical.slice(clamped, clamped + contentHeight);

  return (
    <Box flexDirection="column" height={height} justifyContent="space-between">
      {/* 1. 内容容器：设置 flexGrow={1} 撑满剩余空间 */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((line, index) => (
          <Text key={index} color={line.color} wrap="truncate-end">
            {line.text}
          </Text>
        ))}
      </Box>

      {/* 2. 页码指示器：通过 space-between 被固定锁死在 Box 最底部 */}
      {showIndicator ? (
        <Text color="gray">
          {clamped + 1}-{Math.min(physical.length, clamped + contentHeight)} /{" "}
          {physical.length}
        </Text>
      ) : null}
    </Box>
  );
}

function TokenStats({
  usage,
  current,
  limit,
  errorCount,
}: {
  usage: LLMUsage;
  current: LLMUsage;
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
      <Text color="white" wrap="truncate">
        prompt {usage.promptTokens} · completion {usage.completionTokens} · total{" "}
        {usage.totalTokens}
      </Text>
      <Text color="white" wrap="truncate">
        session {usage.totalTokens} · this task {current.totalTokens} · cache hit {cacheHitRate} · err signatures {errorCount}/3
      </Text>
      <Text color="gray" wrap="truncate">remaining {remaining} / {limit}</Text>
      <Text color="yellow" wrap="truncate">est cost ${cost.toFixed(4)}</Text>
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
  onMaxOffsets,
}: {
  diffs: DiffView[];
  expandedDiffs: Set<number>;
  focus: number;
  offsets: number[];
  width: number;
  height: number;
  onMaxOffsets: (offsets: number[]) => void;
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
  const maxes = diffs.map((diff, index) => {
    const expanded = expandedDiffs.has(index);
    if (!expanded) return 0;
    const lines = [
      `[-] ${diff.path}`,
      ...diff.oldText.split("\n").map((line) => `- ${line}`),
      ...diff.newText.split("\n").map((line) => `+ ${line}`),
    ];
    const physical = lines.flatMap((line) =>
      wrapAnsi(line, width, { hard: true }).split("\n"),
    ).length;
    return Math.max(0, physical - viewport);
  });
  useEffect(() => {
    onMaxOffsets(maxes);
  }, [maxes.join("|"), onMaxOffsets]);
  const offset = offsets[focus] ?? 0;
  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate">
        [ ]/[]] 切换文件 · [f] 展开/收起 · [↑/↓] 滚动
      </Text>
      <StringScrollable
        lines={logical}
        height={Math.max(1, height - 1)}
        offset={offset}
        width={width}
      />
    </Box>
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
        success: event.passed,
        color: event.passed ? "green" : "red",
      };
    case "checklist":
      return {
        kind: "checklist",
        text: `Checklist (${event.items.length})`,
        items: event.items.map((item) => item.id),
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
    case "notice":
      return { kind: "notice", text: event.message, color: "gray" };
    case "review":
      return {
        kind: "notice",
        text: `review ${event.approved ? "✓ approved" : "✗ rejected"}: ${
          event.feedback
        }`,
        color: event.approved ? "green" : "red",
      };
    case "session_task_start":
    case "session_task_end":
      return null;
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

export type ParsedCommand =
  | { type: "ask"; text: string }
  | { type: "run"; command: string }
  | { type: "help" }
  | { type: "save"; path?: string }
  | { type: "clear" }
  | { type: "unknown"; command: string };

export function isEraseKey(
  input: string,
  key: { backspace?: boolean; delete?: boolean },
): boolean {
  return (
    Boolean(key.backspace) ||
    Boolean(key.delete) ||
    input === "\u007f" ||
    input === "\u0008"
  );
}

export function splitLeadingLine(input: string): {
  leading: string;
  hasBreak: boolean;
} {
  const match = input.match(/^([^\r\n]*)(\r\n|\r|\n|$)/);
  return {
    leading: match?.[1] ?? input,
    hasBreak: (match?.[2] ?? "") !== "",
  };
}

export function bounceStep(
  x: number,
  dir: 1 | -1,
  max: number,
): [number, 1 | -1] {
  if (max <= 0) {
    return [0, 1];
  }
  const step = 2;
  const next = x + dir * step;
  if (next >= max) {
    return [max, -1];
  }
  if (next <= 0) {
    return [0, 1];
  }
  return [next, dir];
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/task ")) {
    const text = trimmed.slice(6).trim();
    return text ? { type: "ask", text } : { type: "unknown", command: trimmed };
  }
  if (trimmed === "/task") return { type: "unknown", command: trimmed };
  if (trimmed.startsWith("/run ")) {
    return { type: "run", command: trimmed.slice(5).trim() };
  }
  if (trimmed.startsWith("/bash ")) {
    return { type: "run", command: trimmed.slice(6).trim() };
  }
  if (trimmed === "/help") return { type: "help" };
  if (trimmed === "/clear") return { type: "clear" };
  if (trimmed === "/save") return { type: "save", path: undefined };
  if (trimmed.startsWith("/save ")) {
    return { type: "save", path: trimmed.slice(6).trim() || undefined };
  }
  if (trimmed.startsWith("/")) return { type: "unknown", command: trimmed };
  return { type: "ask", text: trimmed };
}

export interface ConversationEntry {
  index: number;
  task: string;
  answer: string;
  success: boolean;
}

export function buildConversation(events: AgentEvent[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const pending = new Map<number, { task: string; index: number }>();
  for (const event of events) {
    if (event.type === "session_task_start") {
      pending.set(event.index, { task: event.task, index: event.index });
    } else if (event.type === "session_task_end") {
      const start = pending.get(event.index);
      if (start) {
        entries.push({
          index: event.index,
          task: start.task,
          answer: event.answer,
          success: event.success,
        });
        pending.delete(event.index);
      }
    }
  }
  return entries.sort((a, b) => a.index - b.index);
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
    resumed?: boolean;
    splashMs?: number;
    onAsk?: (text: string) => void;
    onSave?: (sessionPath?: string) => void;
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

function countWorkflowLines(
  state: AgentState,
  stateLog: Record<AgentState, ActivityItem[]>,
  expandedStates: Set<AgentState>,
  width: number,
): number {
  const logical = buildWorkflowLines({
    state,
    task: "",
    stateLog,
    expandedStates,
    expandedToolIds: new Set(),
    expandedLlmIds: new Set(),
    width,
  });
  return logical.flatMap((line) =>
    wrapAnsi(line.text, width, { hard: true }).split("\n"),
  ).length;
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
