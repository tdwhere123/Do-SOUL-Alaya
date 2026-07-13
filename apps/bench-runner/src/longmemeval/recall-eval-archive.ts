import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateSeedExtractionReleaseBlocker,
  listEntries,
  readEntryForDiff,
  readLatest,
  releaseHardGateAllowsLatestPassing,
  type BenchName,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { snapshotQuestionIdDigest } from "./snapshot.js";

/**
 * @anchor recall-eval-archive-marker — the parse-surviving discriminator that
 * marks a public/ KPI archive as a fast-loop recall-eval run (NOT a full run).
 *
 * A recall-eval run never re-pays extraction/materialization and inherits its
 * dataset checksum from the snapshot, so its KPI must never be picked as a
 * full-run "latest passing public" baseline. The marker is written as the
 * prefix of KpiPayload.dataset.checksum_source — a defined optional field that
 * survives KpiPayloadSchema.parse (an unknown top-level key would be stripped
 * on round-trip by the non-strict schema). selectFullRunBaseline excludes any
 * archive whose checksum_source starts with this prefix; the recall-eval slug
 * also carries it for audit distinguishability.
 * see also: apps/bench-runner/src/longmemeval/recall-eval.ts (writes it)
 * see also: apps/bench-runner/src/longmemeval/runner.ts (full-run baseline)
 */
export const RECALL_EVAL_ARCHIVE_MARKER = "recall-eval-snapshot";

/** True when a public/ KPI archive was produced by recall-eval, not a full run. */
export function isRecallEvalArchive(payload: KpiPayload): boolean {
  const source = payload.dataset.checksum_source;
  return source !== undefined && source.startsWith(RECALL_EVAL_ARCHIVE_MARKER);
}

const FINDINGS_FILENAME = "findings.md";

/**
 * Select the latest PASSING full-run baseline for a diff, EXCLUDING fast-loop
 * recall-eval archives. The eval package's readLatest buckets public/ entries
 * only by (split, policyShape, simulateReport, embeddingProvider), so a
 * recall-eval archive in the same bucket could otherwise be returned (and its
 * passing pointer could even win the pointer race) — letting a fast-loop run
 * that never paid extraction/materialization stand in as a full run's baseline.
 *
 * Fast path: ask readLatest; if it returns null or a genuine full-run entry,
 * use it (preserving the eval package's pointer + passing semantics). Only when
 * readLatest hands back a recall-eval archive do we fall back to a newest-first
 * scan that skips recall-eval archives and re-applies the same passing gate
 * (no findings.md regression file + release hard gate + no seed-extraction
 * blocker) the eval package uses for latest_passing.
 * see also: packages/eval/src/history/history.ts — entryAllowsLatestPassing
 */
export async function selectFullRunBaseline(
  layout: HistoryLayout,
  benchName: BenchName,
  opts: {
    readonly split: BenchSplit;
    readonly policyShape: BenchPolicyShape;
    readonly simulateReport: BenchSimulateReportMode;
    readonly embeddingProvider: string;
  }
): Promise<KpiPayload | null> {
  const fast = await readLatest(layout, benchName, {
    split: opts.split,
    policyShape: opts.policyShape,
    simulateReport: opts.simulateReport,
    embeddingProvider: opts.embeddingProvider,
    pointerKind: "passing"
  });
  if (fast === null || !isRecallEvalArchive(fast)) {
    return fast;
  }
  const slugs = await listEntries(layout, benchName);
  for (let i = slugs.length - 1; i >= 0; i--) {
    const slug = slugs[i];
    if (slug === undefined) continue;
    const entry = await readEntryForDiff(layout, benchName, slug);
    if (entry === null) continue;
    if (isRecallEvalArchive(entry)) continue;
    if (entry.split !== opts.split) continue;
    if ((entry.policy_shape ?? "stress") !== opts.policyShape) continue;
    if ((entry.simulate_report ?? "none") !== opts.simulateReport) continue;
    if (entry.embedding_provider !== opts.embeddingProvider) continue;
    if (await entryIsPassingFullRun(layout, benchName, slug, entry)) {
      return entry;
    }
  }
  return null;
}

/**
 * The mirror of selectFullRunBaseline for the fast loop: the latest recall-eval
 * archive in the same bucket, so a recall-eval diff compares against a prior
 * recall-eval run (apple-to-apple) rather than a full run. Scans newest-first
 * over recall-eval archives only; no pointer file is consulted because the
 * passing pointer is shared across full + fast archives.
 */
export async function selectRecallEvalBaseline(
  layout: HistoryLayout,
  benchName: BenchName,
  current: KpiPayload
): Promise<KpiPayload | null> {
  const slugs = await listEntries(layout, benchName);
  const matches: Array<{ readonly slug: string; readonly payload: KpiPayload }> = [];
  for (const slug of slugs) {
    const entry = await readEntryForDiff(layout, benchName, slug);
    if (entry === null) continue;
    if (!isRecallEvalArchive(entry)) continue;
    if (!sameRecallEvalBaselineIdentity(entry, current)) continue;
    matches.push({ slug, payload: entry });
  }
  return matches.reduce<typeof matches[number] | null>(latestArchive, null)?.payload ?? null;
}

function sameRecallEvalBaselineIdentity(left: KpiPayload, right: KpiPayload): boolean {
  const leftAttribution = left.recall_eval_attribution;
  const rightAttribution = right.recall_eval_attribution;
  const leftDigest = evaluatedQuestionDigest(left);
  const rightDigest = evaluatedQuestionDigest(right);
  return leftAttribution !== undefined && rightAttribution !== undefined &&
    leftAttribution.recall_config !== undefined &&
    rightAttribution.recall_config !== undefined &&
    leftDigest !== null && leftDigest === rightDigest &&
    sliceIdentityMatches(left, leftAttribution, leftDigest) &&
    sliceIdentityMatches(right, rightAttribution, rightDigest) &&
    JSON.stringify(leftAttribution.evaluation_slice) ===
      JSON.stringify(rightAttribution.evaluation_slice) &&
    left.split === right.split &&
    (left.policy_shape ?? "stress") === (right.policy_shape ?? "stress") &&
    (left.simulate_report ?? "none") === (right.simulate_report ?? "none") &&
    left.embedding_provider === right.embedding_provider &&
    left.dataset.checksum_sha256 === right.dataset.checksum_sha256 &&
    left.dataset.name === right.dataset.name && left.dataset.size === right.dataset.size &&
    left.sample_size === right.sample_size && left.evaluated_count === right.evaluated_count &&
    treatmentIdentityKey(leftAttribution) === treatmentIdentityKey(rightAttribution) &&
    snapshotBindingKey(leftAttribution.snapshot_binding) ===
      snapshotBindingKey(rightAttribution.snapshot_binding) &&
    JSON.stringify(leftAttribution.hydration_binding) ===
      JSON.stringify(rightAttribution.hydration_binding) &&
    JSON.stringify(left.recall_weight_overrides) === JSON.stringify(right.recall_weight_overrides);
}

function sliceIdentityMatches(
  payload: KpiPayload,
  attribution: NonNullable<KpiPayload["recall_eval_attribution"]>,
  digest: string
): boolean {
  const slice = attribution.evaluation_slice;
  return slice !== undefined && slice.evaluated_count === payload.evaluated_count &&
    slice.question_id_digest === digest;
}

function evaluatedQuestionDigest(payload: KpiPayload): string | null {
  const rows = payload.kpi.per_scenario;
  if (rows.length !== payload.evaluated_count) return null;
  return snapshotQuestionIdDigest(rows.map((row) => ({ questionId: row.id })));
}

function treatmentIdentityKey(
  attribution: NonNullable<KpiPayload["recall_eval_attribution"]>
): string {
  return JSON.stringify([
    attribution.embedding_mode,
    attribution.embedding_provider_kind,
    attribution.embedding_provider_label,
    attribution.onnx_threads,
    attribution.onnx_model_artifact_sha256,
    attribution.embedding_supplement ?? null,
    attribution.answer_rerank ?? null,
    attribution.recall_config ?? null
  ]);
}

function snapshotBindingKey(
  binding: NonNullable<KpiPayload["recall_eval_attribution"]>["snapshot_binding"]
): string {
  return JSON.stringify([
    binding.commit_sha7, binding.gate_sha256, binding.worktree_state_sha256,
    binding.extraction_cache_manifest_sha256,
    binding.extraction_cache_requested_turns, binding.extraction_cache_cached_turns,
    binding.extraction_cache_coverage, binding.dataset_sha256,
    binding.question_id_digest, binding.snapshot_manifest_sha256 ?? null,
    binding.producer_recall_pipeline_version ?? null,
    binding.producer_schema_migration_version ?? null
  ]);
}

function latestArchive<T extends { readonly slug: string; readonly payload: KpiPayload }>(
  latest: T | null,
  candidate: T
): T {
  if (latest === null) return candidate;
  const byRunAt = candidate.payload.run_at.localeCompare(latest.payload.run_at);
  if (byRunAt !== 0) return byRunAt > 0 ? candidate : latest;
  return candidate.slug.localeCompare(latest.slug) > 0 ? candidate : latest;
}

async function entryIsPassingFullRun(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string,
  payload: KpiPayload
): Promise<boolean> {
  const findingsPath = join(layout.historyRoot, benchName, slug, FINDINGS_FILENAME);
  try {
    await access(findingsPath);
    return false;
  } catch {
    // ENOENT (or any access failure) => no regression findings file present.
  }
  if (evaluateSeedExtractionReleaseBlocker(payload) !== null) {
    return false;
  }
  return releaseHardGateAllowsLatestPassing(payload);
}
