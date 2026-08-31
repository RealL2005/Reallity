import React, { useEffect, useState } from "react";
import { render, Box, Text } from "ink";
import type { EventBus } from "./events.ts";

interface TuiAppProps {
  bus: EventBus;
}

function TuiApp({ bus }: TuiAppProps) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(
    () =>
      bus.subscribe((event) => {
        setLines((current) => [...current, JSON.stringify(event)].slice(-20));
      }),
    [bus],
  );

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Reallity native coding agent
      </Text>
      {lines.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </Box>
  );
}

export function startTUI(bus: EventBus): () => void {
  const instance = render(<TuiApp bus={bus} />);
  return () => {
    instance.unmount();
  };
}
