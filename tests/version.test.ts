import { test, expect } from "bun:test";
import { VERSION } from "../src/version.ts";

test("VERSION follows semver", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
