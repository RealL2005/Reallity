import { VERSION } from "./version.ts";
import { OpenAICompatibleClient } from "./llm/client.ts";
import { ReallityAgent } from "./agent.ts";
import { EventBus } from "./observer/events.ts";
import { startTUI } from "./observer/tui.tsx";
import { startWebUI } from "./web/server.ts";

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
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "headless",
    task: "",
    workspace: process.cwd(),
    model: process.env.REALLITY_MODEL ?? "gpt-4.1-mini",
    baseURL: process.env.REALLITY_BASE_URL ?? "https://api.openai.com/v1",
    port: 3000,
    showHelp: false,
    showVersion: false,
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

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseCliArgs(argv);

  if (options.showHelp) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (options.showVersion) {
    console.log(VERSION);
    return 0;
  }

  const apiKey = process.env.REALLITY_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing API key. Set REALLITY_API_KEY or OPENAI_API_KEY.",
    );
    return 1;
  }
  if (!options.task) {
    console.error("Missing task. Pass --task \"your request\".");
    return 1;
  }

  const eventBus = new EventBus();
  const client = new OpenAICompatibleClient({
    apiKey,
    baseURL: options.baseURL,
    model: options.model,
  });
  const agent = new ReallityAgent({
    workspaceRoot: options.workspace,
    client,
    eventBus,
  });

  if (options.mode === "web") {
    const instance = startWebUI({
      port: options.port,
      runTask: (task) => agent.run(task),
    });
    console.log(`WebUI listening on http://127.0.0.1:${instance.server.port}`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await instance.stop();
    return 0;
  }

  if (options.mode === "tui") {
    const stopTUI = startTUI(eventBus);
    const result = await agent.run(options.task);
    stopTUI();
    console.log(`Result: ${result.message}`);
    return result.success ? 0 : 1;
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
  "Usage: bun run src/cli.ts --mode <headless|tui|web> --task \"...\"",
  "",
  "Options:",
  "  --mode        headless, tui, or web (default: headless)",
  "  --task        the coding task to run",
  "  --workspace   workspace directory (default: current directory)",
  "  --model       model name (env: REALLITY_MODEL)",
  "  --base-url    OpenAI-compatible API base URL (env: REALLITY_BASE_URL)",
  "  --port        web UI port (default: 3000)",
  "  -h, --help    show help",
  "  -V, --version show version",
].join("\n");
