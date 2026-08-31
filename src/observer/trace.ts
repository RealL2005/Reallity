import type { AgentEvent } from "./events.ts";

export function buildTraceHtml(events: AgentEvent[]): string {
  const diagram = buildStateDiagram(events);
  const tokenChart = buildTokenChart(events);
  const cacheAudit = buildCacheAudit(events);
  const eventRows = events
    .map(
      (event) => `
        <tr>
          <td>${escapeHtml(formatTimestamp(event.timestamp))}</td>
          <td>${escapeHtml(event.type)}</td>
          <td>${summarize(event)}</td>
        </tr>`,
    )
    .join("");
  const eventsJson = escapeHtml(JSON.stringify(events, null, 2));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reallity trace</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <style>
    :root { color-scheme: dark; }
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #0d1117; color: #e6edf3; }
    header { padding: 2rem 2rem 1rem; border-bottom: 1px solid #30363d; }
    h1 { margin: 0 0 .4rem; }
    h2 { margin: 2rem 0 1rem; }
    main { padding: 0 2rem 3rem; max-width: 1200px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 1rem; overflow-x: auto; }
    .mermaid { text-align: center; }
    table { border-collapse: collapse; width: 100%; background: #161b22; }
    th, td { border: 1px solid #30363d; padding: .5rem .7rem; text-align: left; vertical-align: top; }
    th { background: #21262d; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; }
    .metric { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 1rem; }
    .metric strong { display: block; font-size: 1.5rem; }
    .diff-old { color: #ff7b72; background: rgba(248,81,73,.12); }
    .diff-new { color: #7ee787; background: rgba(63,185,80,.12); }
    pre { white-space: pre-wrap; }
    .chart { max-width: 900px; }
  </style>
</head>
<body>
  <header>
    <h1>Reallity agent trace</h1>
    <p>Generated from ${events.length} structured agent events.</p>
  </header>
  <main>
    <h2>FSM decision DAG</h2>
    <div class="card"><div class="mermaid">${escapeHtml(diagram)}</div></div>

    <h2>Token & cache audit</h2>
    <div class="metric-grid">
      <div class="metric">prompt tokens<strong>${cacheAudit.promptTokens}</strong></div>
      <div class="metric">completion tokens<strong>${cacheAudit.completionTokens}</strong></div>
      <div class="metric">total tokens<strong>${cacheAudit.totalTokens}</strong></div>
      <div class="metric">cache hit tokens<strong>${cacheAudit.promptCacheHitTokens}</strong></div>
      <div class="metric">cache miss tokens<strong>${cacheAudit.promptCacheMissTokens}</strong></div>
    </div>
    ${tokenChart ? `<div class="card chart">${tokenChart}</div>` : ""}

    <h2>Event timeline</h2>
    <div class="card">
      <table>
        <thead><tr><th>time</th><th>type</th><th>detail</th></tr></thead>
        <tbody>${eventRows}</tbody>
      </table>
    </div>

    <h2>Raw JSON</h2>
    <div class="card"><pre><code>${eventsJson}</code></pre></div>
  </main>
  <script>mermaid.initialize({ startOnLoad: true, theme: "dark" });</script>
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

interface CacheAudit {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}

function buildCacheAudit(events: AgentEvent[]): CacheAudit {
  const audit: CacheAudit = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
  };

  for (const event of events) {
    if (event.type !== "llm") {
      continue;
    }

    audit.promptTokens += event.usage.promptTokens;
    audit.completionTokens += event.usage.completionTokens;
    audit.totalTokens += event.usage.totalTokens;
    audit.promptCacheHitTokens += event.usage.promptCacheHitTokens;
    audit.promptCacheMissTokens += event.usage.promptCacheMissTokens;
  }

  return audit;
}

function buildTokenChart(events: AgentEvent[]): string {
  const llmEvents = events.filter((event) => event.type === "llm");
  if (llmEvents.length === 0) {
    return "";
  }

  const width = 900;
  const height = 220;
  const padding = 40;
  let cumulative = 0;
  const points = llmEvents.map((event, index) => {
    if (event.type !== "llm") {
      return { x: 0, y: 0 };
    }
    cumulative += event.usage.totalTokens;
    const x =
      padding +
      (index / Math.max(1, llmEvents.length - 1)) * (width - padding * 2);
    const y =
      height -
      padding -
      (cumulative / Math.max(1, cumulative)) * (height - padding * 2);
    return { x, y };
  });
  const polyline = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cumulative token usage">
    <text x="12" y="18" fill="#e6edf3" font-size="14">Cumulative tokens: ${cumulative}</text>
    <polyline fill="none" stroke="#58a6ff" stroke-width="3" points="${polyline}" />
  </svg>`;
}

function summarize(event: AgentEvent): string {
  switch (event.type) {
    case "state":
      return `state=${escapeHtml(event.state)}`;
    case "llm": {
      const content = escapeHtml(event.content || "(tool calls)");
      return `${content} <span class="metric">tokens=${event.usage.totalTokens}</span>`;
    }
    case "tool_start":
      return escapeHtml(event.tool);
    case "tool_result": {
      const result = escapeHtml(`${event.tool} success=${event.success}`);
      const diff = event.diff
        ? `<div class="diff-old">- ${escapeHtml(event.diff.oldText)}</div><div class="diff-new">+ ${escapeHtml(event.diff.newText)}</div>`
        : "";
      return `${result} ${diff}`;
    }
    case "verification":
      return `passed=${event.passed}`;
    case "diagnostic":
      return escapeHtml(event.diagnostic.message);
    case "checkpoint":
      return `${escapeHtml(event.head)} clean=${event.clean}`;
    case "error":
      return escapeHtml(event.message);
    case "finish":
      return `success=${event.success}`;
  }
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
