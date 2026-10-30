import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../../runs/compile-seed.js";
import { newFillStats } from "../../../../runs/extraction/fill/fill-stats.js";
import {
  providerBackedExtractionResult,
  fixtureAttemptAuthority,
  TEST_EXTRACTION_PROVIDER_URL
} from "../extraction-cache-test-fixture.js";

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

export function extractionTurns(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    turnContent: `I remember turn-${index}.`,
    turnMessages: [{
      message_id: `m-${index}`,
      role: "user" as const,
      content: `I remember turn-${index}.`
    }]
  }));
}

export function emptyStatementResponse(userPrompt: string): string {
  const request = JSON.parse(userPrompt) as { messages: readonly { message_id: string }[] };
  return JSON.stringify({ messages: request.messages.map(message => ({ message_id: message.message_id, statements: [] })) });
}

export function retryResult(rateLimitRetries: number, input: { readonly userPrompt: string }) {
  return providerBackedExtractionResult(emptyStatementResponse(input.userPrompt), {
    extractorMeta: {
      recoveryKind: "none" as const,
      retryCount: rateLimitRetries,
      retryClassification: rateLimitRetries === 0
        ? "success_first_try" as const
        : "success_after_retry" as const,
      rateLimitRetries
    }
  });
}

export function cachingExtractor(
  cacheRoot: string,
  delegate: BenchSignalExtractor,
  stats: ReturnType<typeof newFillStats>
): BenchSignalExtractor {
  return createCachingSignalExtractor({
    delegate,
    config: {
      model: "test-model",
      modelFamily: "test-model",
      providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: "provider-default-v1",
      sourcePacking: "session-statements"
    },
    cacheRoot,
    stats,
    ...fixtureAttemptAuthority({ cacheRoot, model: "test-model", requestProfile: "provider-default-v1" })
  });
}

export function groundedTurns() {
  return [{
    turnContent: "User: I completed the review today.",
    turnMessages: [{
      message_id: "q1-m0",
      role: "user" as const,
      content: "I completed the review today."
    }]
  }];
}

export async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}
