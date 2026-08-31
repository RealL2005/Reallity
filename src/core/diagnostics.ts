export interface AgentErrorOptions {
  code?: string;
  recoverable?: boolean;
  cause?: unknown;
}

export class AgentError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentError";
    this.code = options.code ?? "AGENT_ERROR";
    this.recoverable = options.recoverable ?? true;
  }
}

export class CircuitBreakerError extends AgentError {
  constructor(message = "circuit breaker tripped") {
    super(message, {
      code: "CIRCUIT_BREAKER_TRIPPED",
      recoverable: false,
    });
    this.name = "CircuitBreakerError";
  }
}

export interface Diagnostic {
  file?: string;
  line?: number;
  message: string;
  expected?: string;
  actual?: string;
  raw: string;
}

export function parseDiagnostic(raw: string): Diagnostic {
  const fileLineMatch =
    raw.match(/(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+)(?::\d+)?(?:\s|$)/m) ??
    raw.match(/at\s+([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+)(?::\d+)?/m);

  const expectedMatch =
    raw.match(/expected:\s*["']([^"']+)["']/i) ??
    raw.match(/Expected:\s*(.+)/i);
  const actualMatch =
    raw.match(/actual:\s*["']([^"']+)["']/i) ??
    raw.match(/Received:\s*(.+)/i);

  const lines = raw.split("\n").map((line) => line.trim());
  const message =
    lines.find((line) =>
      /(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error:)/i.test(line),
    ) ??
    lines.find((line) => line.length > 0) ??
    "";

  return {
    file: fileLineMatch?.[1],
    line: fileLineMatch ? Number(fileLineMatch[2]) : undefined,
    message,
    expected: cleanMatch(expectedMatch?.[1]),
    actual: cleanMatch(actualMatch?.[1]),
    raw,
  };
}

function cleanMatch(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
