import { test, expect } from "bun:test";
import {
  CircuitBreaker,
  FSMEngine,
  LEGAL_TRANSITIONS,
} from "../../src/fsm/engine.ts";
import { CircuitBreakerError } from "../../src/core/diagnostics.ts";

test("FSMEngine follows the legal happy path", () => {
  const engine = new FSMEngine();

  engine.transition("planner");
  engine.transition("executor");
  engine.transition("verify");
  engine.transition("commit");
  engine.transition("finish");

  expect(engine.state).toBe("finish");
});

test("FSMEngine forbids executor to finish", () => {
  const engine = new FSMEngine();
  engine.transition("planner");
  engine.transition("executor");

  expect(() => engine.transition("finish")).toThrow("Illegal transition");
});

test("FSMEngine allows verify to return to executor for repair", () => {
  const engine = new FSMEngine();
  engine.transition("planner");
  engine.transition("executor");
  engine.transition("verify");
  engine.transition("executor");

  expect(engine.state).toBe("executor");
});

test("FSMEngine enforces the 20-round interaction limit", () => {
  const engine = new FSMEngine({ maxRounds: 20 });

  for (let index = 0; index < 20; index += 1) {
    engine.recordRound();
  }

  expect(() => engine.recordRound()).toThrow("round limit");
});

test("CircuitBreaker trips after three identical error signatures", () => {
  const breaker = new CircuitBreaker(3);

  breaker.recordError("TypeError: undefined is not callable");
  breaker.recordError("TypeError: undefined is not callable");
  expect(breaker.isTripped).toBe(false);

  breaker.recordError("TypeError: undefined is not callable");

  expect(breaker.isTripped).toBe(true);
  expect(breaker.lastSignature).toBe("TypeError: undefined is not callable");
});

test("CircuitBreaker does not trip on unrelated errors", () => {
  const breaker = new CircuitBreaker(3);

  breaker.recordError("TypeError: undefined");
  breaker.recordError("TypeError: undefined");
  breaker.recordError("SyntaxError: missing token");

  expect(breaker.isTripped).toBe(false);
});

test("CircuitBreaker throws when tripped", () => {
  const breaker = new CircuitBreaker(2);

  breaker.recordError("same");
  breaker.recordError("same");

  expect(() => breaker.assertHealthy()).toThrow(CircuitBreakerError);
});

test("LEGAL_TRANSITIONS encodes the mandatory verify gate", () => {
  expect(LEGAL_TRANSITIONS.executor).toContain("verify");
  expect(LEGAL_TRANSITIONS.executor).not.toContain("finish");
});
