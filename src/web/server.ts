import type { AgentRunResult } from "../agent.ts";

const INDEX_HTML = await Bun.file(
  new URL("./index.html", import.meta.url),
).text();

export interface WebUIOptions {
  port: number;
  runTask: (task: string) => Promise<AgentRunResult>;
}

export interface WebUIInstance {
  server: ReturnType<typeof Bun.serve>;
  stop: () => Promise<void>;
}

export function startWebUI(options: WebUIOptions): WebUIInstance {
  const server = Bun.serve({
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/api/run" && request.method === "POST") {
        try {
          const body = (await request.json()) as { task?: string };
          if (!body.task?.trim()) {
            return Response.json(
              { success: false, message: "task is required" },
              { status: 400 },
            );
          }
          const result = await options.runTask(body.task);
          return Response.json(result);
        } catch (error) {
          return Response.json(
            {
              success: false,
              message: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      }

      return new Response(INDEX_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  return {
    server,
    stop: async () => {
      server.stop(true);
    },
  };
}
