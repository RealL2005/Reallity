import { AgentError, CircuitBreakerError } from "../core/diagnostics.ts";
import type { AgentState } from "./types.ts";

export const LEGAL_TRANSITIONS: Record<AgentState, AgentState[]> = {
  init: ["planner"],
  planner: ["executor"],
  executor: ["verify"],
  verify: ["executor", "commit", "rollback"],
  commit: ["finish"],
  rollback: ["planner"],
  finish: [],
};

export class CircuitBreaker {
  private consecutiveCount = 0;
  private currentSignature: string | undefined;

  constructor(
    readonly threshold = 3,
    public lastSignature?: string,
  ) {}

  get isTripped(): boolean {
    return this.consecutiveCount >= this.threshold;
  }

  recordError(signature: string): void {
    if (signature === this.currentSignature) {
      this.consecutiveCount += 1;
    } else {
      this.currentSignature = signature;
      this.consecutiveCount = 1;
    }
    this.lastSignature = signature;
  }

  reset(): void {
    this.consecutiveCount = 0;
    this.currentSignature = undefined;
    this.lastSignature = undefined;
  }

  assertHealthy(): void {
    if (this.isTripped) {
      throw new CircuitBreakerError(
        `circuit breaker tripped after ${this.threshold} identical errors: ${this.lastSignature}`,
      );
    }
  }
}

export class FSMEngine {
  state: AgentState = "init";
  private interactions = 0;
  readonly maxInteractions: number;

  constructor(options: { maxInteractions?: number } = {}) {
    this.maxInteractions = options.maxInteractions ?? 40;
  }

  transition(next: AgentState): void {
    if (!LEGAL_TRANSITIONS[this.state].includes(next)) {
      throw new AgentError(
        `Illegal transition: ${this.state} -> ${next}`,
        { code: "ILLEGAL_FSM_TRANSITION", recoverable: false },
      );
    }

    this.state = next;
  }

  recordInteraction(): void {
    this.interactions += 1;
    if (this.interactions > this.maxInteractions) {
      throw new CircuitBreakerError(
        `interaction limit exceeded after ${this.maxInteractions} interactions`,
      );
    }
  }

  get interactionCount(): number {
    return this.interactions;
  }
}
