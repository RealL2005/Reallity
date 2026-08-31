import { test, expect } from "bun:test";
import {
  AgentError,
  CircuitBreakerError,
  parseDiagnostic,
} from "../../src/core/diagnostics.ts";

test("AgentError carries code and recoverable flags", () => {
  const error = new AgentError("bad tool call", {
    code: "INVALID_TOOL_CALL",
    recoverable: true,
  });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("AgentError");
  expect(error.message).toBe("bad tool call");
  expect(error.code).toBe("INVALID_TOOL_CALL");
  expect(error.recoverable).toBe(true);
});

test("CircuitBreakerError defaults to non-recoverable breaker code", () => {
  const error = new CircuitBreakerError("three identical failures");

  expect(error.name).toBe("CircuitBreakerError");
  expect(error.code).toBe("CIRCUIT_BREAKER_TRIPPED");
  expect(error.recoverable).toBe(false);
});

test("parseDiagnostic extracts Bun-style file, line, expected, and actual", () => {
  const text = [
    "(fail) edit_file rejects duplicate match [0.5ms]",
    "AssertionError: expected",
    "  expected: \"once\"",
    "  actual: \"twice\"",
    " at tests/tools/guards.test.ts:18:5",
  ].join("\n");

  const diagnostic = parseDiagnostic(text);

  expect(diagnostic.file).toBe("tests/tools/guards.test.ts");
  expect(diagnostic.line).toBe(18);
  expect(diagnostic.expected).toBe("once");
  expect(diagnostic.actual).toBe("twice");
  expect(diagnostic.message).toContain("AssertionError");
});

test("parseDiagnostic keeps raw text and tolerates missing structured fields", () => {
  const diagnostic = parseDiagnostic("Error: something went wrong");

  expect(diagnostic.file).toBeUndefined();
  expect(diagnostic.line).toBeUndefined();
  expect(diagnostic.expected).toBeUndefined();
  expect(diagnostic.actual).toBeUndefined();
  expect(diagnostic.message).toBe("Error: something went wrong");
  expect(diagnostic.raw).toBe("Error: something went wrong");
});
