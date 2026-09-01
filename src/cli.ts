import { existsSync } from "node:fs";
import path from "node:path";
import { VERSION } from "./version.ts";
import { OpenAICompatibleClient } from "./llm/client.ts";
import { ReallityAgent } from "./agent.ts";
import { EventBus } from "./observer/events.ts";
import { Session } from "./session.ts";
import { startTUI } from "./observer/tui.tsx";
import { startWebUI } from "./web/server.ts";
import { loadProjectEnvFiles } from "./config.ts";
import { TOOL_SCHEMAS } from "./tools/schemas.ts";
import { renderBanner } from "./banner.ts";

export type CliMode = "headless" | "tui" | "web";

export interface CliOptions {
  mode: CliMode;
  task: string;
  workspace: string;
  model: string;
  baseURL: string;
  port: number;
  showHelp: boolean;
  showVersion: boolean;
  sessionPath?: string;
  saveSessionPath?: string;
  noSession: boolean;
  workspaceExplicit: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "tui",
    task: "",
    workspace: process.env.REALLITY_WORKSPACE?.trim() || process.cwd(),
    model: process.env.REALLITY_MODEL?.trim() || "gpt-4.1-mini",
    baseURL:
      process.env.REALLITY_BASE_URL?.trim() ||
      "https://api.openai.com/v1",
    port: Number(process.env.REALLITY_PORT ?? 3000),
    showHelp: false,
    showVersion: false,
    noSession: false,
    workspaceExplicit: Boolean(process.env.REALLITY_WORKSPACE?.trim()),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--mode":
        options.mode = parseMode(argv[++index]);
        break;
      case "--task":
        options.task = argv[++index] ?? "";
        break;
      case "--workspace":
        options.workspace = argv[++index] ?? process.cwd();
        options.workspaceExplicit = true;
        break;
      case "--model":
        options.model = argv[++index] ?? options.model;
        break;
      case "--base-url":
        options.baseURL = argv[++index] ?? options.baseURL;
        break;
      case "--port":
        options.port = Number(argv[++index] ?? 3000);
        break;
      case "--session":
        options.sessionPath = argv[++index] ?? undefined;
        break;
      case "--save-session":
        options.saveSessionPath = argv[++index] ?? undefined;
        break;
      case "--no-session":
        options.noSession = true;
        break;
      case "--help":
      case "-h":
        options.showHelp = true;
        break;
      case "--version":
      case "-V":
        options.showVersion = true;
        break;
    }
  }

  return options;
}

export interface ResolvedSessionPaths {
  loadPath?: string;
  savePath?: string;
}

export function resolveSessionPaths(options: {
  sessionPath?: string;
  saveSessionPath?: string;
  noSession: boolean;
  workspace: string;
}): ResolvedSessionPaths {
  const defaultSavePath = path.join(
    path.resolve(options.workspace),
    ".reallity",
    "session.json",
  );
  const envSession = process.env.REALLITY_SESSION?.trim() || undefined;

  if (options.noSession) {
    return {
      loadPath: options.sessionPath,
      savePath: options.saveSessionPath ?? options.sessionPath,
    };
  }

  const loadPath =
    options.sessionPath ??
    (envSession && existsSync(envSession) ? envSession : undefined) ??
    (!options.saveSessionPath && existsSync(defaultSavePath)
      ? defaultSavePath
      : undefined);
  const savePath =
    options.saveSessionPath ??
    options.sessionPath ??
    envSession ??
    defaultSavePath;

  return { loadPath, savePath };
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  loadProjectEnvFiles();
  const options = parseCliArgs(argv);

  if (options.showHelp) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (options.showVersion) {
    console.log(VERSION);
    return 0;
  }

  if (options.mode !== "tui") {
    console.log(renderBanner("Reallity"));
  }

  const apiKey = process.env.REALLITY_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing API key. Set REALLITY_API_KEY or OPENAI_API_KEY.",
    );
    return 1;
  }
  if (!options.task && options.mode !== "tui") {
    console.error("Missing task. Pass --task \"your request\".");
    return 1;
  }

  const eventBus = new EventBus();
  const client = new OpenAICompatibleClient({
    apiKey,
    baseURL: options.baseURL,
    model: options.model,
    tools: TOOL_SCHEMAS,
  });
  const agent = new ReallityAgent({
    workspaceRoot: options.workspace,
    client,
    eventBus,
  });

  if (options.mode === "web") {
    const instance = startWebUI({
      port: options.port,
      eventBus,
    });
    const runPromise = agent.run(options.task);
    runPromise.then((result) => {
      console.log(`Task finished: ${result.message}`);
    });
    console.log(
      `Trace WebUI listening on http://127.0.0.1:${instance.server.port}`,
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await instance.stop();
    return 0;
  }

  if (options.mode === "tui") {
    const { loadPath, savePath } = resolveSessionPaths(options);

    let session: Session;
    if (loadPath) {
      try {
        const loaded = await Session.load(loadPath, {
          workspaceRoot: options.workspaceExplicit
            ? options.workspace
            : undefined,
          client,
          eventBus,
          savePath,
          model: options.model,
        });
        session = loaded.session;
      } catch (error) {
        console.error(
          `Failed to resume session ${loadPath}: ${
            error instanceof Error ? error.message : String(error)
          }\nHint: 会话文件不存在时先运行一次任务生成，或检查 --session 路径。`,
        );
        return 1;
      }
    } else {
      session = new Session({
        workspaceRoot: options.workspace,
        client,
        eventBus,
        savePath,
        model: options.model,
      });
    }

    const stopTUI = startTUI(eventBus, {
      model: options.model,
      mode: options.mode,
      task: options.task,
      tokenLimit: Number(process.env.REALLITY_TOKEN_LIMIT ?? 200_000),
      workspaceRoot: session.workspaceRoot,
      resumed: Boolean(loadPath),
      onAsk: (task) => {
        void session.ask(task).catch((error) => {
          eventBus.emit({
            type: "error",
            message: `Task failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            timestamp: Date.now(),
          });
        });
      },
      onSave: (sessionPath) => {
        void (async () => {
          try {
            await session.save(sessionPath);
            eventBus.emit({
              type: "notice",
              message: `Session saved to ${sessionPath ?? session.savePath}`,
              timestamp: Date.now(),
            });
          } catch (error) {
            eventBus.emit({
              type: "error",
              message: `Session save failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              timestamp: Date.now(),
            });
          }
        })();
      },
    });
    if (options.task) {
      void session.ask(options.task);
    }
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    if (session.savePath) {
      try {
        await session.save();
      } catch {
        // best-effort save on exit
      }
    }
    stopTUI();
    return 0;
  }

  const result = await agent.run(options.task);
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

function parseMode(value: string | undefined): CliMode {
  if (value === "tui" || value === "web" || value === "headless") {
    return value;
  }
  return "headless";
}

const HELP_TEXT = [
  "Reallity - native coding agent harness",
  "",
  "Usage: bun run src/cli.ts --mode <tui|headless|web> --task \"...\"",
  "",
  "Options:",
  "  --mode        tui, headless, or web (default: tui)",
  "  --task        the coding task to run",
  "  --workspace   workspace directory (default: current directory)",
  "  --model       model name (env: REALLITY_MODEL)",
  "  --base-url    OpenAI-compatible API base URL (env: REALLITY_BASE_URL)",
  "  --port        trace WebUI port (default: 3000)",
  "  -h, --help    show help",
  "  -V, --version show version",
].join("\n");

if (import.meta.main) {
  process.exit(await runCli());
}
