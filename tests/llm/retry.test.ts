import { test, expect } from "bun:test";
import { retryWithBackoff } from "../../src/llm/retry.ts";

test("retryWithBackoff returns immediately on success", async () => {
  let attempts = 0;

  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      return "ok";
    },
    { sleep: async () => {} },
  );

  expect(result).toBe("ok");
  expect(attempts).toBe(1);
});

test("retryWithBackoff retries a retryable error", async () => {
  let attempts = 0;

  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("temporary");
      }
      return "recovered";
    },
    {
      sleep: async () => {},
      shouldRetry: () => true,
    },
  );

  expect(result).toBe("recovered");
  expect(attempts).toBe(3);
});

test("retryWithBackoff throws after exhausting attempts", async () => {
  let attempts = 0;

  await expect(
    retryWithBackoff(
      async () => {
        attempts += 1;
        throw new Error("always");
      },
      {
        maxAttempts: 4,
        sleep: async () => {},
        shouldRetry: () => true,
      },
    ),
  ).rejects.toThrow("always");

  expect(attempts).toBe(4);
});

test("retryWithBackoff applies exponential jitter", async () => {
  const delays: number[] = [];

  await expect(
    retryWithBackoff(
      async () => {
        throw new Error("fail");
      },
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        jitter: 0.2,
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
        shouldRetry: () => true,
      },
    ),
  ).rejects.toThrow("fail");

  expect(delays).toEqual([100, 200]);
});
