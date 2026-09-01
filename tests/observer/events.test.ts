import { test, expect } from "bun:test";
import { EventBus, type AgentEvent } from "../../src/observer/events.ts";

test("EventBus seeds initial events without notifying listeners", () => {
  const initial: AgentEvent[] = [
    { type: "state", state: "planner", timestamp: 1 },
    { type: "session_task_start", index: 0, task: "first", timestamp: 2 },
  ];
  const bus = new EventBus({ initialEvents: initial });
  const received: AgentEvent[] = [];
  bus.subscribe((event) => received.push(event));
  bus.emit({ type: "state", state: "executor", timestamp: 3 });

  expect(bus.history).toHaveLength(3);
  expect(received).toHaveLength(1);
});

test("session and notice events are emitted and stored", () => {
  const bus = new EventBus();
  bus.emit({ type: "session_task_start", index: 0, task: "hello", timestamp: 1 });
  bus.emit({ type: "notice", message: "saved", timestamp: 2 });
  bus.emit({
    type: "session_task_end",
    index: 0,
    task: "hello",
    success: true,
    answer: "done",
    rounds: 3,
    timestamp: 3,
  });

  expect(bus.history.map((event) => event.type)).toEqual([
    "session_task_start",
    "notice",
    "session_task_end",
  ]);
});
