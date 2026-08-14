import { normalizeMemoryObjectKeySurface, type OpenSemanticFactor } from
  "@do-soul/alaya-protocol";

// Identities are already NFKC-lowercase; surfaces still need the same fold to overlap.

function openSemanticFactorAlignTokens(
  factor: Readonly<OpenSemanticFactor>
): ReadonlySet<string> {
  return new Set(
    [factor.semantic_identity, factor.surface]
      .map(normalizeMemoryObjectKeySurface)
      .filter((token) => token.length > 0)
  );
}

export function openSemanticFactorsOverlap(
  left: Readonly<OpenSemanticFactor>,
  right: Readonly<OpenSemanticFactor>
): boolean {
  const rightTokens = openSemanticFactorAlignTokens(right);
  for (const token of openSemanticFactorAlignTokens(left)) {
    if (rightTokens.has(token)) return true;
  }
  return false;
}

export function openSemanticFactorSetsOverlap(
  left: readonly Readonly<OpenSemanticFactor>[],
  right: readonly Readonly<OpenSemanticFactor>[]
): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightTokens = new Set<string>();
  for (const factor of right) {
    for (const token of openSemanticFactorAlignTokens(factor)) rightTokens.add(token);
  }
  for (const factor of left) {
    for (const token of openSemanticFactorAlignTokens(factor)) {
      if (rightTokens.has(token)) return true;
    }
  }
  return false;
}
