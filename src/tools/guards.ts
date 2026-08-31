import path from "node:path";
import { AgentError } from "../core/diagnostics.ts";

export function assertInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AgentError(
      `Path "${targetPath}" resolves outside workspace: "${resolvedTarget}"`,
      { code: "WORKSPACE_BOUNDARY_VIOLATION" },
    );
  }

  return resolvedTarget;
}

export function assertUniqueMatch(content: string, oldStr: string): number {
  if (oldStr.length === 0) {
    throw new AgentError("old_str must not be empty", {
      code: "EMPTY_OLD_STRING",
    });
  }

  let count = 0;
  let index = content.indexOf(oldStr);

  while (index !== -1) {
    count += 1;
    index = content.indexOf(oldStr, index + oldStr.length);
  }

  if (count !== 1) {
    throw new AgentError(
      count === 0
        ? "old_str was not found; edit_file requires exactly once."
        : `old_str has ${count} matches; edit_file requires exactly once.`,
      { code: "EDIT_FILE_NOT_UNIQUE" },
    );
  }

  return count;
}

export interface BashEnvOptions {
  extra?: Record<string, string>;
}

export function buildBashEnv(options: BashEnvOptions = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: "true",
    DEBIAN_FRONTEND: "noninteractive",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    ...options.extra,
  };
}

export interface RiskAssessment {
  blocked: boolean;
  reason?: string;
}

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(^|\s)rm\s+(-[a-zA-Z]+\s+)*(-r|-R|-rf|-fr|--recursive)\b/i,
    reason: "recursive file deletion",
  },
  {
    pattern: /(^|\s)git\s+reset\s+--hard\b/i,
    reason: "destructive git reset",
  },
  {
    pattern: /(^|\s)git\s+checkout\s+(--\s+)?\.\b/i,
    reason: "destructive working-tree checkout",
  },
  {
    pattern: /(^|\s)sudo\b/i,
    reason: "privilege escalation",
  },
  {
    pattern: /(^|\s)(mkfs|dd)\b/i,
    reason: "filesystem/device destructive operation",
  },
  {
    pattern: /:\s*\(\)\s*\{[^|]*\|\s*[^&]*&\s*\}\s*;/,
    reason: "fork bomb",
  },
  {
    pattern: /(curl|wget)\b[^|]+\|\s*(ba)?sh\b/i,
    reason: "remote script piped to shell",
  },
];

export function classifyHighRiskCommand(command: string): RiskAssessment {
  for (const entry of HIGH_RISK_PATTERNS) {
    if (entry.pattern.test(command)) {
      return { blocked: true, reason: entry.reason };
    }
  }

  return { blocked: false };
}

const MUTATING_BASH_PATTERNS: RegExp[] = [
  /\b(echo|printf|cat)\b[^\n]*>>?/i,
  /\b(mkdir|touch|rm|mv|cp|ln|chmod|chown)\b/i,
  /\b(git\s+(add|commit|reset|checkout|clean|rm|mv))\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall)\b/i,
  /\b(tee|sed\s+-i|perl\s+-i|python\b[^\n]*open\()/i,
];

export function isMutatingBashCommand(command: string): boolean {
  return MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}
