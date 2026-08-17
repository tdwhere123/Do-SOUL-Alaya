import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOfficialApiExtractionRequests
} from "@do-soul/alaya-soul";
import {
  createExtractionRequestPlanDeadline,
  resolveExtractionRequestPlanBudget
} from "../../../longmemeval/extraction/fill/policy/provider-request-plan-budget.js";
import {
  resolveExtractionFillProviderTimeBudget
} from "../../../longmemeval/extraction/fill/policy/provider-time-budget.js";
import { createGardenHttpExtractor } from
  "../../../longmemeval/compile-seed/compile-seed-http.js";

afterEach(() => vi.useRealTimers());

describe("extraction provider request-plan authority", () => {
  it.each([
    [17, 3],
    [64, 8]
  ])("budgets all bounded batches for %i assertions", (assertionCount, batchCount) => {
    const requests = buildOfficialApiExtractionRequests(
      assertionSource(assertionCount),
      []
    );
    const perBatch = resolveExtractionFillProviderTimeBudget(2_048);
    const plan = resolveExtractionRequestPlanBudget(requests, 2_048);

    expect(requests).toHaveLength(batchCount);
    expect(plan.batchCount).toBe(batchCount);
    expect(plan.maximumOutputTokens).toBe(2_048 * batchCount);
    expect(plan.wallClockBudgetMs).toBe(
      perBatch.providerWallClockBudgetMs * batchCount
    );
  });

  it("gives a later truncated batch only the request plan's remaining time", () => {
    let now = 1_000;
    const deadline = createExtractionRequestPlanDeadline({
      budgetMs: 300,
      now: () => now
    });

    expect(deadline.bindRequest(extractRequest(200)).timeoutMs).toBe(200);
    now = 1_240;
    const laterBatch = deadline.bindRequest(extractRequest(200));
    expect(laterBatch.timeoutMs).toBe(60);
    expect(deadline.bindRequest(laterBatch).timeoutMs).toBe(60);
    deadline.dispose();
  });

  it("rejects a batch that starts after the one absolute compile deadline", () => {
    let now = 5_000;
    const deadline = createExtractionRequestPlanDeadline({
      budgetMs: 100,
      now: () => now
    });

    now = 5_100;
    expect(() => deadline.bindRequest(extractRequest(60_000)))
      .toThrow(/request plan deadline/i);
    deadline.dispose();
  });

  it("reports plan expiry during a later batch as a terminal timeout", async () => {
    vi.useFakeTimers();
    const deadline = createExtractionRequestPlanDeadline({ budgetMs: 300 });
    await vi.advanceTimersByTimeAsync(240);
    const extractor = createGardenHttpExtractor({
      providerUrl: "https://provider.invalid/v1",
      model: "test-model",
      requestProfile: "provider-default-v1",
      apiKey: "test-key"
    }, {
      fetch: vi.fn<typeof fetch>(() => new Promise<Response>(() => {})),
      sleep: async () => undefined,
      random: () => 0
    });

    const pending = extractor.extract(deadline.bindRequest({
      systemPrompt: "system",
      userPrompt: "user",
      timeoutMs: 60_000
    }));
    const captured = pending.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(60);
    const error = await captured;

    expect(readRetryClassification(error)).toBe("failure_timeout");
    deadline.dispose();
  });
});

function readRetryClassification(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as {
    readonly benchRetry?: { readonly retryClassification?: unknown };
  }).benchRetry?.retryClassification;
}

function assertionSource(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `I recorded durable detail number ${index + 1}.`
  ).join(" ");
}

function extractRequest(timeoutMs: number) {
  return { systemPrompt: "system", userPrompt: "user", timeoutMs };
}
