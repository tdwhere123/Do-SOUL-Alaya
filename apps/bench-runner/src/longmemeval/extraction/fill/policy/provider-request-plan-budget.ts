import type { OfficialApiExtractionRequest } from "@do-soul/alaya-soul";
import type { BenchSignalExtractor } from
  "../../../compile-seed/compile-seed-types.js";
import {
  resolveExtractionFillProviderTimeBudget
} from "./provider-time-budget.js";
import {
  createExtractionPlanDeadlineError
} from "../../../compile-seed/http/extraction-plan-deadline.js";

const MAX_EXTRACTION_ASSERTIONS = 64;

type ExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];

export interface ExtractionRequestPlanBudget {
  readonly batchCount: number;
  readonly maximumOutputTokens: number;
  readonly wallClockBudgetMs: number;
}

export function resolveExtractionRequestPlanBudget(
  requests: readonly OfficialApiExtractionRequest[],
  maxOutputTokens: number
): ExtractionRequestPlanBudget {
  const assertionCount = requests.reduce(
    (count, request) => count + request.source_assertions.length,
    0
  );
  if (requests.length < 1 || assertionCount > MAX_EXTRACTION_ASSERTIONS) {
    throw new Error("extraction request plan exceeds the bounded assertion authority");
  }
  const perBatch = resolveExtractionFillProviderTimeBudget(maxOutputTokens);
  return Object.freeze({
    batchCount: requests.length,
    maximumOutputTokens: safeProduct(maxOutputTokens, requests.length),
    wallClockBudgetMs: safeProduct(
      perBatch.providerWallClockBudgetMs,
      requests.length
    )
  });
}

export function createExtractionRequestPlanDeadline(input: {
  readonly budgetMs: number;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const deadlineAt = now() + input.budgetMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    createExtractionPlanDeadlineError()
  ), input.budgetMs);
  timer.unref?.();
  return {
    bindRequest: (request: ExtractInput) => bindRequest(
      request, controller, deadlineAt, now
    ),
    dispose: () => clearTimeout(timer)
  };
}

function bindRequest(
  input: ExtractInput,
  controller: AbortController,
  deadlineAt: number,
  now: () => number
): ExtractInput {
  const remainingMs = Math.floor(deadlineAt - now());
  if (remainingMs <= 0) {
    controller.abort(createExtractionPlanDeadlineError());
    throw controller.signal.reason;
  }
  return {
    ...input,
    timeoutMs: Math.min(input.timeoutMs ?? remainingMs, remainingMs),
    abortSignal: input.abortSignal === undefined
      ? controller.signal
      : AbortSignal.any([input.abortSignal, controller.signal])
  };
}

function safeProduct(left: number, right: number): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new Error("extraction request plan budget exceeds the safe integer range");
  }
  return product;
}
