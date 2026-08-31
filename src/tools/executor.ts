import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentError,
  parseDiagnostic,
} from "../core/diagnostics.ts";
import {
  bashArgsSchema,
  editFileArgsSchema,
  globArgsSchema,
  listDirArgsSchema,
  readFileArgsSchema,
  toolNameSchema,
  type ToolName,
} from "./schemas.ts";
import {
  assertInsideWorkspace,
  assertUniqueMatch,
  buildBashEnv,
  classifyHighRiskCommand,
} from "./guards.ts";
import { analyzeSource, isCodeFile } from "../guards/ast.ts";
import type { ToolCall } from "../core/context.ts";
import { truncateOutput } from "../core/context.ts";

export interface ExecutorContext {
  workspaceRoot: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface ToolResult {
  toolCallId: string;
  name: ToolName;
  output: string;
  success: boolean;
  error?: string;
  diff?: {
    path: string;
    oldText: string;
    newText: string;
  };
  diagnostic?: ReturnType<typeof parseDiagnostic>;
}

export async function executeTool(
  call: ToolCall,
  context: ExecutorContext,
): Promise<ToolResult> {
  const nameResult = toolNameSchema.safeParse(call.function.name);
  if (!nameResult.success) {
    return failure(call, "unknown tool", "Unknown tool name");
  }

  const name = nameResult.data;
  let args: Record<string, unknown>;

  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return failure(call, name, "Tool arguments must be valid JSON");
  }

  try {
    const output = await dispatch(name, args, context);
    const diff =
      name === "edit_file"
        ? {
            path: String(args.path),
            oldText: String(args.old_str),
            newText: String(args.new_str),
          }
        : undefined;
    return {
      toolCallId: call.id,
      name,
      output: limitOutput(output, context.maxOutputChars),
      success: true,
      ...(diff ? { diff } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(call, name, message);
  }
}

async function dispatch(
  name: ToolName,
  args: Record<string, unknown>,
  context: ExecutorContext,
): Promise<string> {
  switch (name) {
    case "read_file":
      return executeReadFile(readFileArgsSchema.parse(args), context);
    case "edit_file":
      return executeEditFile(editFileArgsSchema.parse(args), context);
    case "bash":
      return executeBash(bashArgsSchema.parse(args), context);
    case "list_dir":
      return executeListDir(listDirArgsSchema.parse(args), context);
    case "glob":
      return executeGlob(globArgsSchema.parse(args), context);
  }
}

async function executeReadFile(
  args: { path: string; start_line?: number; end_line?: number },
  context: ExecutorContext,
): Promise<string> {
  const resolved = assertInsideWorkspace(context.workspaceRoot, args.path);
  const content = await readFile(resolved, "utf8");

  if (args.start_line === undefined && args.end_line === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const start = args.start_line ?? 1;
  const end = args.end_line ?? lines.length;

  if (start < 1 || end < start) {
    throw new AgentError("Invalid line range", { code: "INVALID_LINE_RANGE" });
  }

  return lines.slice(start - 1, end).join("\n");
}

async function executeEditFile(
  args: { path: string; old_str: string; new_str: string },
  context: ExecutorContext,
): Promise<string> {
  const resolved = assertInsideWorkspace(context.workspaceRoot, args.path);
  const content = await readFile(resolved, "utf8");
  assertUniqueMatch(content, args.old_str);
  const updated = content.replace(args.old_str, args.new_str);

  if (isCodeFile(resolved)) {
    const analysis = analyzeSource(updated, resolved);
    if (!analysis.ok) {
      throw new AgentError(
        `AST guardrail rejected edit: ${analysis.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join("; ")}`,
        { code: "AST_GUARDRAIL_FAILED" },
      );
    }
  }

  await writeFile(resolved, updated, "utf8");

  return `Edited ${args.path}: replaced ${args.old_str.length} chars with ${args.new_str.length} chars.`;
}

async function executeListDir(
  args: { path: string },
  context: ExecutorContext,
): Promise<string> {
  const resolved = assertInsideWorkspace(context.workspaceRoot, args.path);
  const entries = await readdir(resolved, { withFileTypes: true });
  const lines = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();

  return lines.join("\n");
}

async function executeGlob(
  args: { pattern: string; path: string },
  context: ExecutorContext,
): Promise<string> {
  const root = assertInsideWorkspace(context.workspaceRoot, args.path);
  const matcher = globToRegExp(args.pattern);
  const matches: string[] = [];

  async function walk(directory: string, relativePrefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativePrefix
        ? path.join(relativePrefix, entry.name)
        : entry.name;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile() && matcher.test(relative)) {
        matches.push(relative);
      }
    }
  }

  await walk(root, "");
  return matches.sort().join("\n");
}

async function executeBash(
  args: { command: string },
  context: ExecutorContext,
): Promise<string> {
  const risk = classifyHighRiskCommand(args.command);
  if (risk.blocked) {
    throw new AgentError(
      `Blocked command: ${risk.reason}`,
      { code: "HIGH_RISK_COMMAND" },
    );
  }

  return runBashCommand(args.command, context);
}

function runBashCommand(
  command: string,
  context: ExecutorContext,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: context.workspaceRoot,
      env: buildBashEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, context.timeoutMs ?? 30_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = `${stdout}${stderr}`.trim();
      writeFileSync("/tmp/agent_bash_latest.log", raw, "utf8");

      if (timedOut) {
        reject(
          new AgentError("bash command timed out", {
            code: "BASH_TIMEOUT",
          }),
        );
        return;
      }

      if (code !== 0) {
        reject(
          new AgentError(
            `bash exited with code ${code}\n${truncateOutput(raw)}`,
            { code: "BASH_NONZERO_EXIT" },
          ),
        );
        return;
      }

      resolve(raw);
    });
  });
}

function failure(
  call: ToolCall,
  name: string,
  error: string,
): ToolResult {
  return {
    toolCallId: call.id,
    name: name as ToolName,
    output: "",
    success: false,
    error,
    diagnostic: parseDiagnostic(error),
  };
}

function limitOutput(output: string, maxChars?: number): string {
  const max = maxChars ?? 8_000;
  if (output.length <= max) {
    return output;
  }

  return `${output.slice(0, max)}\n... [output truncated]`;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`);
}
