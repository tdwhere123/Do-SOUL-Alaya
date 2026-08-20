import type { SelectGammaQualityParts } from "./types.js";

export function selectGammaQuality(parts: SelectGammaQualityParts): number {
  const total = parts.relevance + parts.temporal_fit;
  if (!Number.isFinite(total)) {
    throw new Error("Select_Gamma quality parts must be finite");
  }
  return Math.max(0, total);
}
