import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { clamp01 } from "./recall-service-helpers.js";

export function scoreQueryEvidenceMatch(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (queryProbes.normalized_query === null || queryProbes.lexical_terms.length === 0) {
    return 0;
  }

  const content = normalizeEvidenceText(entry.content);
  const metadata = normalizeEvidenceText([...entry.domain_tags, ...entry.evidence_refs].join(" "));
  const terms = queryProbes.lexical_terms.slice(0, 32);
  const hitStats = collectEvidenceTermHitStats(terms, content, metadata);
  if (hitStats.hitWeight === 0) {
    return 0;
  }
  const phraseHits = countEvidencePhraseHits(queryProbes, content);
  const termCoverage = clamp01(hitStats.hitWeight / Math.max(1, terms.length));
  const phraseScore = clamp01(phraseHits / 3);
  const tokenCount = Math.max(8, splitEvidenceTokens(content).length);
  const densityScore = clamp01(hitStats.contentHits / Math.sqrt(tokenCount));
  const conciseScore = computeEvidenceConciseScore(hitStats.contentHits, content.length);
  return clamp01(termCoverage * 0.48 + phraseScore * 0.12 + densityScore * 0.08 + conciseScore);
}

function collectEvidenceTermHitStats(
  terms: readonly string[],
  content: string,
  metadata: string
): Readonly<{ readonly hitWeight: number; readonly contentHits: number }> {
  let hitWeight = 0;
  let contentHits = 0;
  for (const term of terms) {
    const needle = normalizeEvidenceText(term);
    if (needle.length === 0) {
      continue;
    }
    const hitInContent = containsEvidenceNeedle(content, needle);
    const hitInMetadata = !hitInContent && containsEvidenceNeedle(metadata, needle);
    if (hitInContent) {
      hitWeight += 1;
      contentHits += 1;
    } else if (hitInMetadata) {
      hitWeight += 0.65;
    }
  }
  return Object.freeze({ hitWeight, contentHits });
}

function countEvidencePhraseHits(
  queryProbes: Readonly<RecallQueryProbes>,
  content: string
): number {
  return queryProbes.phrases
    .slice(0, 12)
    .filter((phrase) => containsEvidenceNeedle(content, normalizeEvidenceText(phrase)))
    .length;
}

function computeEvidenceConciseScore(contentHits: number, contentLength: number): number {
  if (contentHits <= 0) {
    return 0;
  }
  if (contentLength <= 420) {
    return 0.04;
  }
  return contentLength <= 1_200 ? 0.02 : 0;
}

export function normalizeEvidenceText(value: string): string {
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

function containsEvidenceNeedle(haystack: string, rawNeedle: string): boolean {
  const needle = normalizeEvidenceText(rawNeedle).trim();
  if (needle.length === 0) {
    return false;
  }
  if (needle.includes(" ") || /[^\p{Script=Latin}\p{N}_-]/u.test(needle)) {
    return haystack.includes(needle);
  }
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}_-])`, "u");
  return pattern.test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function scoreEvidenceAnchorMatch(
  entry: Readonly<MemoryEntry>,
  evidenceRefs: ReadonlySet<string>
): number {
  const overlapCount = entry.evidence_refs.reduce(
    (count, ref) => evidenceRefs.has(ref) ? count + 1 : count,
    0
  );
  if (overlapCount === 0) {
    return 0;
  }
  return clamp01(0.55 + overlapCount * 0.1);
}
