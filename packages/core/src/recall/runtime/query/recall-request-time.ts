import { captureEffectiveAsOf } from "../../query/condition/query-condition-capture.js";

export type RecallRequestTimeContext = Readonly<{
  readonly capturedAt: string;
  readonly effectiveAsOf: string;
  readonly captureOperationalTime: () => string;
}>;

export function captureRecallRequestTime(input: Readonly<{
  readonly explicitAsOf?: string;
  readonly now: () => string;
}>): RecallRequestTimeContext {
  const capturedAt = captureEffectiveAsOf(undefined, input.now);
  const effectiveAsOf = input.explicitAsOf === undefined
    ? capturedAt
    : validatedExplicitAsOf(input.explicitAsOf, capturedAt);
  return Object.freeze({
    capturedAt,
    effectiveAsOf,
    captureOperationalTime: () => captureEffectiveAsOf(undefined, input.now)
  });
}

function validatedExplicitAsOf(explicitAsOf: string, capturedAt: string): string {
  captureEffectiveAsOf(explicitAsOf, () => capturedAt);
  return explicitAsOf;
}
