import { test, expect } from "bun:test";
import { startWebUI } from "../../src/web/server.ts";
import { EventBus } from "../../src/observer/events.ts";

test("startWebUI serves the generated trace report and event JSON", async () => {
  const bus = new EventBus();
  bus.emit({ type: "state", state: "planner", timestamp: 1 });
  bus.emit({
    type: "llm",
    content: "plan",
    toolCalls: [],
    usage: {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 10,
    },
    timestamp: 2,
  });

  const instance = startWebUI({
    port: 0,
    eventBus: bus,
  });

  try {
    const port = instance.server.port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    const trace = await fetch(`http://127.0.0.1:${port}/`);
    const traceHtml = await trace.text();
    expect(trace.status).toBe(200);
    expect(traceHtml).toContain("Reallity agent trace");
    expect(traceHtml).toContain("Token & cache audit");
    expect(traceHtml).toContain("planner");

    const events = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(events.status).toBe(200);
    expect(await events.json()).toHaveLength(2);
  } finally {
    await instance.stop();
  }
});
