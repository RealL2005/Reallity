import { test, expect } from "bun:test";
import {
  parseReviewResponse,
  reviewResponseFromToolCalls,
} from "../../src/verify/review.ts";

test("parseReviewResponse extracts approved JSON from prose", () => {
  const response = parseReviewResponse(
    'Here is the review: {"approved": true, "feedback": "looks good"}',
  );

  expect(response).toEqual({ approved: true, feedback: "looks good" });
});

test("parseReviewResponse returns null for non-JSON", () => {
  expect(parseReviewResponse("no json here")).toBeNull();
});

test("reviewResponseFromToolCalls parses a structured review tool call", () => {
  const result = reviewResponseFromToolCalls([
    {
      id: "call_1",
      type: "function",
      function: {
        name: "submit_review",
        arguments: '{"approved": false, "feedback": "fix loop"}',
      },
    },
  ]);

  expect(result).toEqual({ approved: false, feedback: "fix loop" });
});
