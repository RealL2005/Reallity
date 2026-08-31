import { spawn } from "node:child_process";
import { parseDiagnostic, type Diagnostic } from "../core/diagnostics.ts";
import { buildBashEnv } from "../tools/guards.ts";

export interface VerificationResult {
  passed: boolean;
  exitCode: number;
  output: string;
  diagnostics: Diagnostic[];
}

export interface RunBunTestsOptions {
  bunCommand?: string;
  timeoutMs?: number;
  args?: string[];
}

export function buildVerificationResult(
  output: string,
  exitCode: number,
): VerificationResult {
  const diagnostics =
    exitCode === 0 ? [] : parseDiagnostics(output);

  return {
    passed: exitCode === 0,
    exitCode,
    output,
    diagnostics,
  };
}

export async function runBunTests(
  workspaceRoot: string,
  options: RunBunTestsOptions = {},
): Promise<VerificationResult> {
  const bunCommand = options.bunCommand ?? "bun";
  const args = options.args ?? ["test"];

  return runCommand(bunCommand, args, workspaceRoot, options.timeoutMs ?? 30_000).then(
    ({ output, exitCode }) => buildVerificationResult(output, exitCode),
  );
}

export interface ReviewPromptInput {
  requirement: string;
  diff: string;
  files: string[];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  return [
    "You are a Code Reviewer. Review this diff against the original requirement.",
    "Return only JSON: {\"approved\": boolean, \"feedback\": string}.",
    "",
    `Requirement: ${input.requirement}`,
    "",
    `Changed files: ${input.files.join(", ")}`,
    "",
    "Diff:",
    input.diff,
  ].join("\n");
}

function parseDiagnostics(output: string): Diagnostic[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return [parseDiagnostic(trimmed)];
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildBashEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

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
      resolve({
        output: `${stdout}${stderr}`,
        exitCode: code ?? 1,
      });
    });
  });
}
