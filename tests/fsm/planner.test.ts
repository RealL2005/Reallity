import { test, expect } from "bun:test";
import { extractChecklist } from "../../src/fsm/planner.ts";

test("extractChecklist parses markdown checkboxes", () => {
  const content = [
    "Here is my plan:",
    "- [ ] add the failing test",
    "- [ ] run it and watch it fail",
    "- [ ] implement the fix",
  ].join("\n");

  expect(extractChecklist(content)).toEqual([
    "add the failing test",
    "run it and watch it fail",
    "implement the fix",
  ]);
});

test("extractChecklist parses numbered task lines", () => {
  const content = ["Plan:", "1. create schema", "2. run tests"].join("\n");

  expect(extractChecklist(content)).toEqual(["create schema", "run tests"]);
});

test("extractChecklist returns an empty list without plan markers", () => {
  expect(extractChecklist("No plan here")).toEqual([]);
});
