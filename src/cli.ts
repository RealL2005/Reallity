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
  sessionRequested: boolean;
  saveSessionRequested: boolean;
  noSession: boolean;
  workspaceExplicit: boolean;
  maxInteractions?: number;
  toolRoundsBeforeVerify?: number;
  stagnationLimit?: number;
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
    sessionRequested: false,
    saveSessionRequested: false,
    workspaceExplicit: Boolean(process.env.REALLITY_WORKSPACE?.trim()),
    maxInteractions: Number(process.env.REALLITY_MAX_INTERACTIONS?.trim() ?? 0) || undefined,
    toolRoundsBeforeVerify:
      Number(process.env.REALLITY_TOOL_ROUNDS_BEFORE_VERIFY?.trim() ?? 0) ||
      undefined,
    stagnationLimit:
      Number(process.env.REALLITY_STAGNATION_LIMIT?.trim() ?? 0) || undefined,
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
        options.sessionRequested = true;
        break;
      case "--save-session":
        options.saveSessionPath = argv[++index] ?? undefined;
        options.saveSessionRequested = true;
        break;
      case "--no-session":
        options.noSession = true;
        break;
      case "--max-interactions":
        options.maxInteractions = Number(argv[++index] ?? 0) || undefined;
        break;
      case "--tool-rounds-before-verify":
        options.toolRoundsBeforeVerify =
          Number(argv[++index] ?? 0) || undefined;
        break;
      case "--stagnation-limit":
        options.stagnationLimit = Number(argv[++index] ?? 0) || undefined;
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
  freshPersistent?: boolean;
}

export function resolveSessionPaths(options: {
  sessionPath?: string;
  saveSessionPath?: string;
  sessionRequested: boolean;
  saveSessionRequested: boolean;
  noSession: boolean;
  workspace: string;
}): ResolvedSessionPaths {
  const defaultPath = path.join(
    path.resolve(options.workspace),
    ".reallity",
    "session.json",
  );
  const envSession = process.env.REALLITY_SESSION?.trim() || undefined;

  if (options.noSession) {
    return {
      loadPath: options.sessionRequested
        ? options.sessionPath ?? defaultPath
        : undefined,
      savePath: options.saveSessionRequested
        ? options.saveSessionPath ?? defaultPath
        : options.sessionRequested
          ? options.sessionPath ?? defaultPath
          : undefined,
    };
  }

  if (options.sessionRequested) {
    const resumePath = options.sessionPath ?? defaultPath;
    const explicitPath = options.sessionPath !== undefined;
    if (!explicitPath && !existsSync(resumePath)) {
      // 裸 --session：默认会话文件不存在 → 开启持久化新会话（自动创建该文件）
      return { loadPath: undefined, savePath: resumePath, freshPersistent: true };
    }
    return {
      loadPath: resumePath,
      savePath: options.saveSessionRequested
        ? options.saveSessionPath ?? defaultPath
        : resumePath,
    };
  }

  if (options.saveSessionRequested) {
    return {
      loadPath: undefined,
      savePath: options.saveSessionPath ?? defaultPath,
    };
  }

  if (envSession) {
    return {
      loadPath: existsSync(envSession) ? envSession : undefined,
      savePath: envSession,
    };
  }

  return { loadPath: undefined, savePath: undefined };
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
    maxInteractions: options.maxInteractions,
    toolRoundsBeforeVerify: options.toolRoundsBeforeVerify,
    stagnationLimit: options.stagnationLimit,
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
    const sessionPaths = resolveSessionPaths(options);
    const { loadPath, savePath } = sessionPaths;

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
          maxInteractions: options.maxInteractions,
          toolRoundsBeforeVerify: options.toolRoundsBeforeVerify,
          stagnationLimit: options.stagnationLimit,
        });
        session = loaded.session;
      } catch (error) {
        console.error(
          `Failed to resume session ${loadPath}: ${
            error instanceof Error ? error.message : String(error)
          }\nHint: 该会话文件不存在。若想使用默认路径，直接运行 reallity --session（会自动新建并保存）；或检查 --session 路径是否笔误。`,
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
        maxInteractions: options.maxInteractions,
        toolRoundsBeforeVerify: options.toolRoundsBeforeVerify,
        stagnationLimit: options.stagnationLimit,
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
            const targetPath =
              sessionPath ??
              path.join(
                path.resolve(session.workspaceRoot),
                ".reallity",
                "session.json",
              );
            await session.save(targetPath);
            eventBus.emit({
              type: "notice",
              message: `Session saved to ${targetPath}`,
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
    if (sessionPaths.freshPersistent) {
      eventBus.emit({
        type: "notice",
        message: `新持久化会话：任务结果将自动保存到 ${sessionPaths.savePath}（之后用 reallity --session 恢复）`,
        timestamp: Date.now(),
      });
    }
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
  "  --session [path]       resume a conversation (default: .reallity/session.json)",
  "  --save-session [path]  auto-save this conversation (default: .reallity/session.json)",
  "  --no-session           start fresh without any persistence",
  "  --max-interactions N   LLM interaction safety cap (default: 200)",
  "  --tool-rounds-before-verify N   force verify interval (default: 6)",
  "  --stagnation-limit N    consecutive identical rounds before rollback (default: 3)",
  "  -h, --help    show help",
  "  -V, --version show version",
].join("\n");

if (import.meta.main) {
  process.exit(await runCli());
}
