import type { SoulRecallTokenizerHint } from "@do-soul/alaya-protocol";
import type {
  RecallTemporalProjectionReadOptions,
  TokenEstimator
} from "./recall-service-port-types.js";

/**
 * Keeps the current-projection call shape compatible with legacy two-argument
 * readers while making an explicit historical projection opt-in.
 */
export function readWithTemporalProjection<T>(
  asOf: string | undefined,
  readCurrent: () => Promise<T>,
  readHistorical: (options: RecallTemporalProjectionReadOptions) => Promise<T>
): Promise<T> {
  return asOf === undefined ? readCurrent() : readHistorical({ asOf });
}

export function makeTokenEstimator(opts: {
  readonly hint?: SoulRecallTokenizerHint | null;
} = {}): TokenEstimator {
  const charsPerToken = resolveCharsPerToken(opts.hint ?? null);

  return Object.freeze({
    estimate(text: string): number {
      return Math.ceil(text.length / charsPerToken);
    }
  });
}

function resolveCharsPerToken(hint: SoulRecallTokenizerHint | null): number {
  switch (hint) {
    case "cl100k":
      // Conservative chars/token heuristic, not a native tokenizer.
      return 3.6;
    case "o200k":
      return 3.2;
    case "approx_chars_per_token":
    case null:
      return 4;
  }
}
