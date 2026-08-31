import { buildTraceHtml } from "../observer/trace.ts";
import type { EventBus } from "../observer/events.ts";

export interface WebUIOptions {
  port: number;
  eventBus: EventBus;
}

export interface WebUIInstance {
  server: ReturnType<typeof Bun.serve>;
  stop: () => Promise<void>;
}

export function startWebUI(options: WebUIOptions): WebUIInstance {
  const server = Bun.serve({
    port: options.port,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/api/events") {
        return Response.json(options.eventBus.history);
      }

      const html = buildTraceHtml(options.eventBus.history);
      return new Response(html, {
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
