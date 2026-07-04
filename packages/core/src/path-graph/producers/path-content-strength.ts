// invariant: when ALAYA_PATHREL_CONTENT_STRENGTH is disabled, edge creation
// writes the fixed seed-profile constants; when enabled, relation_kind bands map
// the content-classification score to strength and recall_bias magnitude.

import { getCoreConfig } from "../../config/install-core-config.js";
import { clamp01 } from "../../shared/clamp.js";

// invariant: only an explicit truthy ALAYA_PATHREL_CONTENT_STRENGTH enables
// content-driven path strength.
export function pathRelContentStrengthEnabled(): boolean {
  const raw = getCoreConfig().pathGraph.pathrelContentStrength;
  return raw === "on" || raw === "1" || raw === "true";
}

export type ContentDrivenStrength = Readonly<{
  readonly strength: number;
  readonly recallBiasMagnitude: number;
}>;

// Per-kind floor/ceiling for the content-driven band. derives_from (provenance,
// answer-relational) earns the highest ceiling; coheres_with (token-Jaccard
// lexical coherence) the lowest so a topical neighbor is never over-amplified;
// co_recalled (co-occurrence) sits between. Unlisted kinds keep their constants.
const CONTENT_STRENGTH_BANDS: Readonly<Record<string, { readonly floor: number; readonly ceiling: number }>> =
  Object.freeze({
    derives_from: { floor: 0.45, ceiling: 0.95 },
    supports: { floor: 0.4, ceiling: 0.85 },
    co_recalled: { floor: 0.3, ceiling: 0.65 },
    coheres_with: { floor: 0.25, ceiling: 0.55 }
  });

export function hasContentStrengthBand(relationKind: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTENT_STRENGTH_BANDS, relationKind);
}

// Map a [0,1] content score onto the kind's band linearly; both strength and
// recall_bias magnitude share the band so the recall scorer's two positive terms
// (plasticity_state.strength*0.55 + effect_vector.recall_bias*0.25) both move.
export function contentDrivenStrength(
  relationKind: string,
  contentScore: number
): ContentDrivenStrength | undefined {
  const band = CONTENT_STRENGTH_BANDS[relationKind];
  if (band === undefined) {
    return undefined;
  }
  const score = clamp01(contentScore);
  const value = clamp01(band.floor + (band.ceiling - band.floor) * score);
  return Object.freeze({ strength: value, recallBiasMagnitude: value });
}

const CONTENT_STRENGTH_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "the", "this", "to", "use", "uses", "with"
]);

// Token-Jaccard over normalized content tokens — the SAME formula the edge-auto
// producer heuristic uses (edge-auto-producer-heuristics.ts tokenize/jaccard), so
// the offline backfill reproduces the in-process content score exactly.
export function contentTokenJaccard(left: string, right: string): number {
  const leftTokens = contentStrengthTokens(left);
  const rightTokens = contentStrengthTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const rightSet = new Set(rightTokens);
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function contentStrengthTokens(content: string): readonly string[] {
  return Array.from(
    new Set(
      content
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter((token) => token.length > 1 && !CONTENT_STRENGTH_STOPWORDS.has(token)) ?? []
    )
  );
}
