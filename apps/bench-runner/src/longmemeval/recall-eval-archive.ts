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
 * cross-file: apps/bench-runner/src/longmemeval/recall-eval.ts (writes it)
 * cross-file: apps/bench-runner/src/longmemeval/runner.ts (full-run baseline)
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
 * cross-file: packages/eval/src/history.ts entryAllowsLatestPassing
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
  opts: {
    readonly split: BenchSplit;
    readonly policyShape: BenchPolicyShape;
    readonly simulateReport: BenchSimulateReportMode;
    readonly embeddingProvider: string;
  }
): Promise<KpiPayload | null> {
  const slugs = await listEntries(layout, benchName);
  for (let i = slugs.length - 1; i >= 0; i--) {
    const slug = slugs[i];
    if (slug === undefined) continue;
    const entry = await readEntryForDiff(layout, benchName, slug);
    if (entry === null) continue;
    if (!isRecallEvalArchive(entry)) continue;
    if (entry.split !== opts.split) continue;
    if ((entry.policy_shape ?? "stress") !== opts.policyShape) continue;
    if ((entry.simulate_report ?? "none") !== opts.simulateReport) continue;
    if (entry.embedding_provider !== opts.embeddingProvider) continue;
    return entry;
  }
  return null;
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
