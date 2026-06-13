import type { RerankCandidate } from "../../recall/recall-feature-rerank.js";

export interface FakeCandidate {
  readonly id: string;
}

/**
 * Build a rerank candidate. `fusionScore` defaults to a flat value so the
 * fusion contribution is constant across a list and the lexical features
 * alone decide ordering — that isolates the feature logic under test.
 * Tests that exercise the fusion-vs-rerank blend set `fusionScore`
 * explicitly.
 */
export function candidate(
  id: string,
  content: string,
  options: { readonly fusionScore?: number; readonly hasEvidenceLexicalHit?: boolean } = {}
): RerankCandidate<FakeCandidate> {
  return Object.freeze({
    item: Object.freeze({ id }),
    fusionScore: options.fusionScore ?? 0.1,
    text: Object.freeze({
      content,
      hasEvidenceLexicalHit: options.hasEvidenceLexicalHit ?? false
    })
  });
}

export function ids<T extends { readonly id: string }>(result: readonly T[]): readonly string[] {
  return result.map((entry) => entry.id);
}
