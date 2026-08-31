import { test, expect } from "bun:test";
import { startWebUI } from "../../src/web/server.ts";

test("startWebUI serves health and runs a task", async () => {
  const instance = startWebUI({
    port: 0,
    runTask: async (task) => ({
      success: true,
      message: `ran ${task}`,
      tracePath: "/tmp/trace.html",
    }),
  });

  try {
    const port = instance.server.port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    const run = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "inspect" }),
    });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({
      success: true,
      message: "ran inspect",
    });
  } finally {
    await instance.stop();
  }
});
