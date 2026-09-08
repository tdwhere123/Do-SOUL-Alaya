import type { RecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { clamp01 } from "../helpers.js";

export function scoreQueryEvidenceContent(
  contentRaw: string,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (queryProbes.normalized_query === null || queryProbes.lexical_terms.length === 0) {
    return 0;
  }

  const content = normalizeEvidenceText(contentRaw);
  const termNeedles = compileEvidenceNeedles(queryProbes.lexical_terms.slice(0, 32));
  const contentHits = termNeedles.filter((needle) => containsCompiledEvidenceNeedle(content, needle)).length;
  if (contentHits === 0) {
    return 0;
  }
  const phraseHits = compileEvidenceNeedles(queryProbes.phrases.slice(0, 12))
    .filter((needle) => containsCompiledEvidenceNeedle(content, needle)).length;
  const termCoverage = clamp01(contentHits / Math.max(1, termNeedles.length));
  const phraseScore = clamp01(phraseHits / 3);
  const tokenCount = Math.max(8, splitEvidenceTokens(content).length);
  const densityScore = clamp01(contentHits / Math.sqrt(tokenCount));
  const conciseScore = content.length <= 420 ? 0.04 : content.length <= 1_200 ? 0.02 : 0;
  return clamp01(termCoverage * 0.48 + phraseScore * 0.12 + densityScore * 0.08 + conciseScore);
}

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[’‘]/gu, "'")
    .toLocaleLowerCase();
}

function splitEvidenceTokens(value: string): readonly string[] {
  return value
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token.length > 0);
}

interface EvidenceNeedle {
  readonly value: string;
  readonly boundaryPattern: RegExp | null;
}

function compileEvidenceNeedles(rawNeedles: readonly string[]): readonly EvidenceNeedle[] {
  return rawNeedles.flatMap((rawNeedle): readonly EvidenceNeedle[] => {
    const needle = normalizeEvidenceText(rawNeedle).trim();
    if (needle.length === 0) {
      return [];
    }
    if (needle.includes(" ") || /[^\p{Script=Latin}\p{N}_-]/u.test(needle)) {
      return [Object.freeze({ value: needle, boundaryPattern: null })];
    }
    return [
      Object.freeze({
        value: needle,
        boundaryPattern: new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}_-])`, "u")
      })
    ];
  });
}

function containsCompiledEvidenceNeedle(haystack: string, needle: EvidenceNeedle): boolean {
  if (needle.boundaryPattern === null) {
    return haystack.includes(needle.value);
  }
  return needle.boundaryPattern.test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
