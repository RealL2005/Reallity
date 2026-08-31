import type { AgentEvent } from "./events.ts";

export function buildTraceHtml(events: AgentEvent[]): string {
  const diagram = buildStateDiagram(events);
  const eventsJson = escapeHtml(JSON.stringify(events, null, 2));
  const eventRows = events
    .map(
      (event) =>
        `<li><strong>${escapeHtml(event.type)}</strong> ${escapeHtml(
          summarize(event),
        )}</li>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reallity trace</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <style>
    body { font-family: ui-monospace, monospace; margin: 2rem; background: #111; color: #eee; }
    .mermaid { background: #161616; padding: 1rem; border-radius: 8px; }
    ul { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>Reallity agent trace</h1>
  <div class="mermaid">${escapeHtml(diagram)}</div>
  <h2>Events</h2>
  <ul>${eventRows}</ul>
  <h2>Raw JSON</h2>
  <pre><code>${eventsJson}</code></pre>
  <script>mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`;
}

function buildStateDiagram(events: AgentEvent[]): string {
  const states = events
    .filter((event) => event.type === "state")
    .map((event) => event.state);
  const uniqueStates = [...new Set(states)];
  const transitions: string[] = [];

  for (let index = 0; index < states.length - 1; index += 1) {
    transitions.push(`${states[index]} --> ${states[index + 1]}`);
  }

  return [
    "stateDiagram-v2",
    ...uniqueStates.map((state) => `  ${state}`),
    ...transitions.map((transition) => `  ${transition}`),
  ].join("\n");
}

function summarize(event: AgentEvent): string {
  switch (event.type) {
    case "state":
      return `state=${event.state}`;
    case "llm":
      return event.content;
    case "tool_start":
      return event.tool;
    case "tool_result":
      return `${event.tool} success=${event.success}`;
    case "verification":
      return `passed=${event.passed}`;
    case "diagnostic":
      return event.diagnostic.message;
    case "checkpoint":
      return `${event.head} clean=${event.clean}`;
    case "error":
      return event.message;
    case "finish":
      return `success=${event.success}`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
