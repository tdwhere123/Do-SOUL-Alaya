import {
  createTimeConcernWindowDigest,
  normalizeTimeConcernWindowDigest
} from "@do-soul/alaya-protocol";
import { parseTemporalQueryTermWindow } from "../scoring/temporal-fusion-scoring.js";

export function resolveTimeConcernQueryDigests(
  dateTerms: readonly string[],
  asOf?: string
): readonly string[] {
  const digests: string[] = [];
  const seen = new Set<string>();
  for (const term of dateTerms) {
    addUnique(digests, seen, normalizeTimeConcernWindowDigest(term));
    const window = parseTemporalQueryTermWindow(term, asOf);
    if (window !== null) {
      addUnique(
        digests,
        seen,
        createTimeConcernWindowDigest(window.startMs, window.endMs)
      );
    }
  }
  return Object.freeze(digests);
}

function addUnique(output: string[], seen: Set<string>, value: string): void {
  if (value.length === 0 || seen.has(value)) return;
  seen.add(value);
  output.push(value);
}
