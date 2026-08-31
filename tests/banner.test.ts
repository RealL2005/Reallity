import { test, expect } from "bun:test";
import { renderBanner } from "../src/banner.ts";

test("renderBanner produces a non-empty figlet banner", () => {
  const banner = renderBanner("A");

  expect(banner.trim().length).toBeGreaterThan(0);
  expect(banner.split("\n").length).toBeGreaterThan(1);
});

test("renderBanner uses a monospaced figlet font", () => {
  const banner = renderBanner("Hi");
  const lines = banner.split("\n").filter((line) => line.length > 0);

  expect(lines.length).toBeGreaterThan(1);
  expect(new Set(lines.map((line) => line.length)).size).toBeLessThanOrEqual(3);
});
