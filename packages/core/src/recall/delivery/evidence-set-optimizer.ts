import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { recallEnvRaw } from "../../config/recall-env-access.js";
import type { RecallSupplementaryData } from "../runtime/recall-service-types.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { collectQueryTermHits, normalizeEvidenceText } from "../scoring/query-evidence-scoring.js";
import {
  appendRemainder,
  COVERAGE_MIN_SCORE_RATIO_ENV,
  COVERAGE_SELECTOR_ENV,
  DEFAULT_MIN_SCORE_RATIO,
  dateBucketOf,
  type DeliveryCandidate,
  isAdmissible,
  readRatioEnv,
  resolveCoveragePoolK,
  resolveCoverageTargetK,
  sessionKeyOf
} from "./coverage-delivery-signals.js";
import {
  type EvidenceSetCoverageState,
  MAX_EVIDENCE_SET_BONUS,
  createEvidenceSetCoverageState,
  evidenceSetCoverageBonus,
  evidenceSetCoverageEnabled,
  recordEvidenceSetSelection
} from "./evidence-set-coverage.js";

const FACET_PREFIX_WEIGHT: Readonly<Record<string, number>> = {
  "L:": 0.1,
  "S:": 0.0833,
  "O:": 0.075,
  "E:": 0.05,
  "C:": 0.0417,
  "D:": 0.025,
  "M:": 0.0167
};

// Near-tie nudge, not an override: total facet bonus never exceeds one strong facet, so it only reorders candidates close in score.
const MAX_COVERAGE_BONUS = 0.1;

const MULTI_FACT_LIST_CUE = /\b(all|both|each|list|every|multiple|several|compare|across)\b/iu;

type SelectorMode = "off" | "force" | "default";
type FacetAxis = "session" | "source_cohort" | "evidence_ref" | "date_bucket" | "dimension" | "entity" | "lexical_term";

function resolveSelectorMode(): SelectorMode {
  const raw = recallEnvRaw(COVERAGE_SELECTOR_ENV);
  if (raw === undefined) {
    return "default";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "" || normalized === "0" || normalized === "false" || normalized === "off") {
    return "off";
  }
  return "force";
}

function entityProbeTokens(probes: Readonly<RecallQueryProbes>): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const raw of [
    ...probes.object_ids,
    ...probes.task_refs,
    ...probes.package_names,
    ...probes.command_names,
    ...probes.file_paths
  ]) {
    const token = normalizeEvidenceText(raw);
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return tokens;
}

function computeActiveFacetAxes(
  probes: Readonly<RecallQueryProbes>,
  entityTokens: ReadonlySet<string>
): ReadonlySet<FacetAxis> {
  const axes = new Set<FacetAxis>(["session", "source_cohort", "evidence_ref"]);
  if (probes.date_terms.length >= 1) axes.add("date_bucket");
  if (probes.dimensions.length >= 2) axes.add("dimension");
  if (entityTokens.size >= 1) axes.add("entity");
  if (probes.lexical_terms.length >= 3) axes.add("lexical_term");
  return axes;
}

interface FacetContext {
  readonly supplementaryData: RecallSupplementaryData;
  readonly probes: Readonly<RecallQueryProbes>;
  readonly activeAxes: ReadonlySet<FacetAxis>;
  readonly entityTokens: ReadonlySet<string>;
  readonly queryEvidenceRefs: ReadonlySet<string>;
}

function facetSignature(entry: Readonly<MemoryEntry>, ctx: FacetContext): ReadonlySet<string> {
  const signature = new Set<string>();
  if (ctx.activeAxes.has("session")) {
    signature.add(`S:${sessionKeyOf(entry)}`);
  }
  if (ctx.activeAxes.has("source_cohort")) {
    const cohort = ctx.supplementaryData.sourceCohortKeys[entry.object_id];
    if (cohort !== undefined) signature.add(`C:${cohort}`);
  }
  if (ctx.activeAxes.has("evidence_ref")) {
    for (const ref of entry.evidence_refs) {
      if (ctx.queryEvidenceRefs.size === 0 || ctx.queryEvidenceRefs.has(ref)) {
        signature.add(`E:${ref}`);
      }
    }
  }
  if (ctx.activeAxes.has("date_bucket")) {
    const bucket = dateBucketOf(entry);
    if (bucket !== null) signature.add(`D:${bucket}`);
  }
  if (ctx.activeAxes.has("dimension")) {
    signature.add(`M:${entry.dimension}`);
  }
  if (ctx.activeAxes.has("entity")) {
    if (ctx.entityTokens.has(normalizeEvidenceText(entry.object_id))) {
      signature.add(`O:${normalizeEvidenceText(entry.object_id)}`);
    }
    for (const tag of entry.domain_tags) {
      const token = normalizeEvidenceText(tag);
      if (ctx.entityTokens.has(token)) signature.add(`O:${token}`);
    }
  }
  if (ctx.activeAxes.has("lexical_term")) {
    for (const term of collectQueryTermHits(entry, ctx.probes)) {
      signature.add(`L:${term}`);
    }
  }
  return signature;
}

// Relevance stays primary: score ratio plus an additive bonus per newly-covered facet.
function coverageUtility(base: number, signature: ReadonlySet<string>, covered: ReadonlySet<string>): number {
  let bonus = 0;
  for (const facet of signature) {
    if (!covered.has(facet)) {
      bonus += FACET_PREFIX_WEIGHT[facet.slice(0, 2)] ?? 0;
    }
  }
  return base + Math.min(bonus, MAX_COVERAGE_BONUS);
}

function hasTextualMultiFactIntent(
  probes: Readonly<RecallQueryProbes>,
  entityTokens: ReadonlySet<string>
): boolean {
  if (probes.date_terms.length >= 2) return true;
  if (entityTokens.size >= 2) return true;
  if (probes.dimensions.length >= 2) return true;
  return probes.normalized_query !== null && MULTI_FACT_LIST_CUE.test(probes.normalized_query);
}

interface PoolBreadth {
  readonly crossSessionStrong: boolean;
  readonly crossSessionNovelTerm: boolean;
}

// What the realized pool offers vs the head. crossSessionStrong (>=2 above-ratio sessions) is the mandatory data condition; crossSessionNovelTerm is true when a strong other-session candidate matches a query term the head does not (a second sub-clause fact, not a term-repeating distractor).
function analyzePoolBreadth<T extends DeliveryCandidate>(
  pool: readonly T[],
  head: T,
  probes: Readonly<RecallQueryProbes>,
  headScore: number,
  minScoreRatio: number
): PoolBreadth {
  const headSession = sessionKeyOf(head.entry);
  const headHits = collectQueryTermHits(head.entry, probes);
  const strongSessions = new Set<string>();
  let crossSessionNovelTerm = false;
  for (const candidate of pool) {
    const ratio = headScore > 0 ? candidate.fusion.fused_score / headScore : 0;
    if (ratio < minScoreRatio) continue;
    const session = sessionKeyOf(candidate.entry);
    strongSessions.add(session);
    if (session !== headSession) {
      for (const term of collectQueryTermHits(candidate.entry, probes)) {
        if (!headHits.has(term)) {
          crossSessionNovelTerm = true;
          break;
        }
      }
    }
  }
  return { crossSessionStrong: strongSessions.size >= 2, crossSessionNovelTerm };
}

// Whether coverage reordering runs: off-switch + no-op guards, then force OR (cross-session evidence AND plausibly multi-fact).
export function coverageReorderGateOpen<T extends DeliveryCandidate>(
  ordered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): boolean {
  const mode = resolveSelectorMode();
  if (mode === "off" || maxEntries <= 1 || ordered.length <= 1) {
    return false;
  }
  const targetK = resolveCoverageTargetK(maxEntries);
  if (targetK <= 1) {
    return false;
  }
  const pool = ordered.slice(0, resolveCoveragePoolK(ordered.length, targetK));
  const head = pool[0];
  if (head === undefined) {
    return false;
  }
  if (mode === "force") {
    return true;
  }
  const minScoreRatio = readRatioEnv(COVERAGE_MIN_SCORE_RATIO_ENV, DEFAULT_MIN_SCORE_RATIO);
  const probes = supplementaryData.queryProbes;
  const breadth = analyzePoolBreadth(pool, head, probes, head.fusion.fused_score, minScoreRatio);
  return (
    breadth.crossSessionStrong &&
    (hasTextualMultiFactIntent(probes, entityProbeTokens(probes)) || breadth.crossSessionNovelTerm)
  );
}

export function applyEvidenceSetDelivery<T extends DeliveryCandidate>(
  ordered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): readonly T[] {
  if (!coverageReorderGateOpen(ordered, supplementaryData, maxEntries)) {
    return ordered;
  }
  const targetK = resolveCoverageTargetK(maxEntries);
  const poolK = resolveCoveragePoolK(ordered.length, targetK);
  const pool = ordered.slice(0, poolK);
  const head = pool[0]!;
  const headScore = head.fusion.fused_score;
  const minScoreRatio = readRatioEnv(COVERAGE_MIN_SCORE_RATIO_ENV, DEFAULT_MIN_SCORE_RATIO);
  const probes = supplementaryData.queryProbes;
  const entityTokens = entityProbeTokens(probes);

  const ctx: FacetContext = {
    supplementaryData,
    probes,
    activeAxes: computeActiveFacetAxes(probes, entityTokens),
    entityTokens,
    queryEvidenceRefs: new Set(probes.evidence_refs)
  };

  const evidenceState = evidenceSetCoverageEnabled()
    ? createEvidenceSetCoverageState(pool, supplementaryData)
    : null;
  const covered = new Set<string>();
  const selected: T[] = [head];
  const selectedSet = new Set<T>([head]);
  recordSelection(head, ctx, covered, evidenceState, supplementaryData);

  while (selected.length < targetK) {
    const best = selectBestByCoverageUtility(pool, selectedSet, covered, ctx, targetK, headScore, minScoreRatio, evidenceState);
    if (best === undefined) {
      break;
    }
    selected.push(best);
    selectedSet.add(best);
    recordSelection(best, ctx, covered, evidenceState, supplementaryData);
  }

  return appendRemainder(ordered, selected, selectedSet);
}

function recordSelection<T extends DeliveryCandidate>(
  candidate: T,
  ctx: FacetContext,
  covered: Set<string>,
  evidenceState: EvidenceSetCoverageState | null,
  supplementaryData: RecallSupplementaryData
): void {
  if (evidenceState !== null) {
    recordEvidenceSetSelection(evidenceState, candidate, supplementaryData);
    return;
  }
  for (const facet of facetSignature(candidate.entry, ctx)) covered.add(facet);
}

function selectBestByCoverageUtility<T extends DeliveryCandidate>(
  pool: readonly T[],
  selectedSet: ReadonlySet<T>,
  covered: ReadonlySet<string>,
  ctx: FacetContext,
  targetK: number,
  headScore: number,
  minScoreRatio: number,
  evidenceState: EvidenceSetCoverageState | null
): T | undefined {
  let best: T | undefined;
  let bestUtility = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < pool.length; index += 1) {
    const candidate = pool[index]!;
    if (selectedSet.has(candidate)) {
      continue;
    }
    const suppressed = (ctx.supplementaryData.pathSuppressionScores?.[candidate.entry.object_id] ?? 0) > 0;
    if (!isAdmissible(candidate.fusion, index + 1, targetK, headScore, minScoreRatio, suppressed)) {
      continue;
    }
    const base = headScore > 0 ? Math.min(1, candidate.fusion.fused_score / headScore) : 0;
    const utility = evidenceState !== null
      ? base + Math.min(MAX_EVIDENCE_SET_BONUS, evidenceSetCoverageBonus(evidenceState, candidate, ctx.supplementaryData))
      : coverageUtility(base, facetSignature(candidate.entry, ctx), covered);
    if (utility > bestUtility) {
      bestUtility = utility;
      best = candidate;
    }
  }
  return best;
}
