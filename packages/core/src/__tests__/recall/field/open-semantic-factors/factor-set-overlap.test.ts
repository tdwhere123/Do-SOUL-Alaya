import { describe, expect, it } from "vitest";
import type { OpenSemanticFactor } from "@do-soul/alaya-protocol";
import {
  openSemanticFactorSetsOverlap,
  openSemanticFactorsOverlap
} from "../../../../recall/field/open-semantic-factors/factor-identity.js";

describe("open semantic factor set overlap", () => {
  it("is true iff some pairwise identity or normalized-surface overlap is true", () => {
    const book = factor("book", "books", "book");
    const bought = factor("buy", "bought", "purchase");
    const boughtSurface = factor("buy-e", "Bought", "buy");
    const cjkBook = factor("book-zh", "书籍", "书籍");
    const cjkBookIdentity = factor("book-zh-q", "书", "书籍");
    const cjkTea = factor("tea-zh", "茶", "tea");
    const identityHit = factor("id-hit", "surface-left", "shared");
    const surfaceHit = factor("surface-hit", "Shared", "other");
    const lateLeft = [
      factor("alpha", "alpha", "alpha"),
      factor("beta", "beta", "beta")
    ];
    const lateRight = [
      factor("gamma", "gamma", "gamma"),
      factor("delta", "beta", "delta")
    ];

    const graphs: readonly (readonly [
      readonly OpenSemanticFactor[],
      readonly OpenSemanticFactor[]
    ])[] = [
      [[], []],
      [[], [book]],
      [[book], []],
      [[book], [book]],
      [[bought], [boughtSurface]],
      [lateLeft, lateRight],
      [[cjkBook], [cjkBookIdentity]],
      [[cjkBook], [cjkTea]],
      [[identityHit], [surfaceHit]]
    ];

    expect(openSemanticFactorSetsOverlap([], [book])).toBe(false);
    expect(openSemanticFactorSetsOverlap([book], [])).toBe(false);
    expect(openSemanticFactorSetsOverlap([cjkBook], [cjkBookIdentity])).toBe(true);
    expect(openSemanticFactorSetsOverlap([cjkBook], [cjkTea])).toBe(false);
    expect(openSemanticFactorSetsOverlap(lateLeft, lateRight)).toBe(true);

    for (const [left, right] of graphs) {
      expect(openSemanticFactorSetsOverlap(left, right)).toBe(
        pairwiseFactorOverlap(left, right)
      );
    }
  });
});

function pairwiseFactorOverlap(
  left: readonly OpenSemanticFactor[],
  right: readonly OpenSemanticFactor[]
): boolean {
  return left.some((leftFactor) =>
    right.some((rightFactor) => openSemanticFactorsOverlap(leftFactor, rightFactor)));
}

function factor(
  factorId: string,
  surface: string,
  semanticIdentity: string
): OpenSemanticFactor {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity,
    source_span: [0, Math.max(1, surface.length)]
  };
}
