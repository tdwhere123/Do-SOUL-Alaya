import { describe, expect, it } from "vitest";
import { newFillStats } from
  "../../../longmemeval/extraction/fill/fill-stats.js";
import { resolveFullFillStatus } from
  "../../../longmemeval/extraction/fill/policy/full-fill-completion.js";
import { countIntentionalSkippedTurns } from
  "../../../longmemeval/extraction/fill/policy/cache-key-allowlist.js";
import type { PreparedExtractionFill } from
  "../../../longmemeval/extraction/fill/fill-preparation.js";

describe("full fill completion with an intentional allowlist remainder", () => {
  it("accepts the observed 87 missing as 77 skipped plus 10 terminal failures", () => {
    const intentionalSkippedTurns = countIntentionalSkippedTurns(23_807, 23_424, 306);
    expect(intentionalSkippedTurns).toBe(77);
    expect(resolveFullFillStatus(input({
      validTurns: 23_720,
      missingTurns: 87,
      cacheHits: 23_424,
      llmCalls: 296,
      terminalFailures: 10,
      intentionalSkippedTurns
    }))).toBe("in_progress");
  });

  it("fails closed when skips and terminal failures do not explain missing", () => {
    expect(() => resolveFullFillStatus(input({
      validTurns: 23_721,
      missingTurns: 86,
      cacheHits: 23_424,
      llmCalls: 296,
      terminalFailures: 10,
      intentionalSkippedTurns: 77
    }))).toThrow(/do not explain|task conservation/u);
  });

  it("keeps a complete full-window fill complete", () => {
    expect(resolveFullFillStatus(input({
      validTurns: 23_807,
      missingTurns: 0,
      cacheHits: 23_501,
      llmCalls: 306,
      terminalFailures: 0,
      intentionalSkippedTurns: 0
    }))).toBe("complete");
  });
});

function input(values: {
  readonly validTurns: number;
  readonly missingTurns: number;
  readonly cacheHits: number;
  readonly llmCalls: number;
  readonly terminalFailures: number;
  readonly intentionalSkippedTurns: number;
}) {
  const terminal = {
    failure_max_retries: values.terminalFailures,
    failure_non_retryable_4xx: 0,
    failure_timeout: 0,
    failure_aborted: 0
  };
  return {
    prepared: { requestedTurns: 23_807 } as PreparedExtractionFill,
    stats: { ...newFillStats(), cacheHits: values.cacheHits, llmCalls: values.llmCalls },
    completion: {
      expectedTurns: 23_807,
      validTurns: values.validTurns,
      missingTurns: values.missingTurns,
      invalidTurns: 0,
      orphanTurns: 0,
      coverage: values.validTurns / 23_807,
      expectedKeySetSha256: "a".repeat(64),
      partialContentClosureSha256: "b".repeat(64),
      contentClosureSha256: values.missingTurns === 0 ? "c".repeat(64) : null,
      contentClosureIndex: values.missingTurns === 0 ? {} : null
    },
    telemetry: {
      retrySuccesses: 0,
      rateLimitRetries: 0,
      adaptiveConcurrencyBackoffs: 0,
      adaptiveConcurrencyBackoffMs: 0,
      terminalRetryClassifications: terminal
    },
    repairScopeTurns: undefined,
    allowProviderTaskFailures: true,
    intentionalSkippedTurns: values.intentionalSkippedTurns
  };
}
