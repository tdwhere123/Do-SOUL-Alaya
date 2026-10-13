import { expect, it, vi } from "vitest";
import { formatFillFailure } from "../../cli/output/fill-failure-diagnostic.js";
import { ExtractionFillTaskError } from "../../runs/extraction/fill/fill-pool.js";

it("keeps original-before-release order and nested causes", () => {
  const primary = new Error("prepare failed", { cause: new TypeError("invalid source binding") });
  const diagnostic = formatFillFailure(new AggregateError([primary, new Error("release failed")], "fill failed"));
  expect(diagnostic).toBe("fill failed | errors[0]=Error: prepare failed | errors[1]=Error: release failed | errors[0].cause=TypeError: invalid source binding");
});

it.each([false, true])("keeps provider task causes opaque inside aggregates=%s", (aggregate) => {
  const task = new ExtractionFillTaskError({
    retryClassification: "unknown", retrySuccesses: 0, rateLimitRetries: 0,
    processedTurns: 1, requestedTurns: 2,
    cause: new Error("sk-fixture-secret PROMPT_BODY", { cause: new Error("private request body") })
  });
  const diagnostic = formatFillFailure(aggregate ? new AggregateError([task, new Error("release failed")], "fill failed") : task);
  expect(diagnostic).toContain("cause=Error");
  expect(diagnostic).not.toMatch(/sk-fixture-secret|PROMPT_BODY|private request body/u);
  if (aggregate) expect(diagnostic).toContain("release failed");
});

it("retains non-error categories without coercing unknown objects or exposing thrown strings", () => {
  const toString = vi.fn(() => "sk-fixture-secret");
  const diagnostic = formatFillFailure(new AggregateError([undefined, { toString }, "private prompt", null], "fill failed"));
  expect(diagnostic).toContain("errors[0]=non_error_undefined");
  expect(diagnostic).toContain("errors[1]=non_error_object");
  expect(diagnostic).toContain("errors[2]=non_error_string");
  expect(diagnostic).toContain("errors[3]=non_error_null");
  expect(toString).not.toHaveBeenCalled();
  expect(diagnostic).not.toMatch(/sk-fixture-secret|private prompt/u);
});

it("redacts credentials and URLs in nested messages without printing stacks or error fields", () => {
  const cause = Object.assign(new Error('api_key="quoted secret"; Authorization: Bearer opaque-token; sk-proj-key; Authorization: Basic dXNlcjpmaXh0dXJlLXNlY3JldA=='), {
    stack: "PRIVATE_STACK", responseBody: "PRIVATE_BODY", headers: { authorization: "PRIVATE_HEADER" }
  });
  const diagnostic = formatFillFailure(new Error("transport https://user:password@example.test/?token=private", { cause }));
  expect(diagnostic).toContain("transport [redacted-url]");
  expect(diagnostic).toContain("[redacted]");
  expect(diagnostic).not.toMatch(/quoted secret|opaque-token|sk-proj-key|user:password|token=private|dXNlcjpmaXh0dXJlLXNlY3JldA==|PRIVATE_/u);
});

it("uses the same credential redaction for nested and opaque task cause names", () => {
  const cause = Object.assign(new Error("safe failure"), { name: "sk-fixture-secret" });
  const task = new ExtractionFillTaskError({ retryClassification: "unknown", retrySuccesses: 0,
    rateLimitRetries: 0, processedTurns: 1, requestedTurns: 2, cause });
  expect(formatFillFailure(task)).toContain("cause=Error");
  expect(formatFillFailure(new AggregateError([cause, task], "fill failed"))).not.toContain("sk-fixture-secret");
});

it("bounds cyclic, deep and wide error trees and individual messages", () => {
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(formatFillFailure(cycle)).toContain("[already reported]");
  let deep = new Error("unreachable-deep-message");
  for (let index = 0; index < 10; index += 1) deep = new Error(`level ${index}`, { cause: deep });
  const wide = new AggregateError([cycle, deep, new Error("x".repeat(10_000)), new Error("release failed"),
    new Error("unreachable-wide-message")], "fill failed");
  const diagnostic = formatFillFailure(wide);
  expect(diagnostic.length).toBeLessThanOrEqual(4_096);
  expect(diagnostic).toContain("[truncated]");
  expect(diagnostic).toContain("release failed");
  expect(diagnostic).not.toMatch(/unreachable-(?:deep|wide)-message/u);
});

it("keeps the direct release failure visible when the original has a wide nested error tree", () => {
  const original = new AggregateError([0, 1, 2, 3].map(index => new AggregateError(
    [0, 1, 2, 3].map(detail => new Error(`detail ${index}-${detail}`)), `operation ${index}`)), "original failed");
  const diagnostic = formatFillFailure(new AggregateError([original, new Error("release ownership changed")], "fill failed"));
  expect(diagnostic).toMatch(/original failed.*release ownership changed/u);
  expect(diagnostic.length).toBeLessThanOrEqual(4_096);
  expect(diagnostic).toContain("[truncated]");
});
