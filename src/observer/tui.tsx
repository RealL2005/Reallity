import React, { useEffect, useState } from "react";
import { render, Box, Text } from "ink";
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
  diff?: DiffView;
  usage?: LLMUsage;
  events: number;
  running: boolean;
}

function TuiApp({ bus }: TuiAppProps) {
  const [snapshot, setSnapshot] = useState<TuiSnapshot>({
    state: "init",
    llm: "",
    tool: "",
    events: 0,
    running: true,
  });

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
            next.llm = event.content || "(tool calls)";
            next.usage = event.usage;
          } else if (event.type === "tool_start") {
            next.tool = `Running ${event.tool}`;
            next.diff = undefined;
          } else if (event.type === "tool_result") {
            next.tool = `${event.tool} ${event.success ? "ok" : "failed"}`;
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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Reallity
        </Text>
        <Text color="gray">
          state: {snapshot.state}
          {snapshot.running ? " • " : ""}
          {snapshot.running ? "running" : "done"}
        </Text>
      </Box>

      <Box borderStyle="round" flexDirection="column" paddingX={1} marginY={1}>
        <Text bold color="white">
          LLM
        </Text>
        <Text>{snapshot.llm || "Waiting for planner..."}</Text>
      </Box>

      <Box borderStyle="round" flexDirection="column" paddingX={1} marginBottom={1}>
        <Text bold color="white">
          Tool
        </Text>
        <Text>{snapshot.tool || "No tool activity yet"}</Text>
      </Box>

      {snapshot.diff ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="white">
            Diff: {snapshot.diff.path}
          </Text>
          <Text color="red">- {snapshot.diff.oldText}</Text>
          <Text color="green">+ {snapshot.diff.newText}</Text>
        </Box>
      ) : null}

      {snapshot.usage ? (
        <Box>
          <Text color="gray">
            tokens {snapshot.usage.totalTokens} / prompt{" "}
            {snapshot.usage.promptTokens} / completion{" "}
            {snapshot.usage.completionTokens} / cache hit{" "}
            {snapshot.usage.promptCacheHitTokens}
          </Text>
        </Box>
      ) : null}

      <Text color="gray">events: {snapshot.events}</Text>
    </Box>
  );
}

export function startTUI(bus: EventBus): () => void {
  const instance = render(<TuiApp bus={bus} />);
  return () => {
    instance.unmount();
  };
}
