import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  listEntries,
  readEntryForDiff,
  type BenchName,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  summarizeLongMemEvalRecallEvidence,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalRecallEvidenceSummary,
  type LongMemEvalReportSideEffectSummary
} from "./diagnostics.js";
import {
  aggregateLongMemEvalArchiveEvidence,
  buildDelta,
  isNotFound,
  normalizeRecallEvidenceSummary,
  oppositeColdWarmMode,
  toComparisonEntry
} from "./archive-evidence-helpers.js";
export { aggregateLongMemEvalArchiveEvidence } from "./archive-evidence-helpers.js";

export const LONGMEMEVAL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json";
export const LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME =
  "longmemeval-cold-warm-comparison.json";

export interface LongMemEvalArchiveEvidenceSummary {
  readonly report_side_effects: LongMemEvalReportSideEffectSummary | null;
  readonly scored_recall_evidence: LongMemEvalRecallEvidenceSummary | null;
}

export interface LongMemEvalArchiveComparisonEntry {
  readonly slug: string | null;
  readonly run_at: string;
  readonly simulate_report: BenchSimulateReportMode;
  readonly r_at_1: number;
  readonly r_at_5: number;
  readonly r_at_10: number;
  readonly tier_distribution: KpiPayload["kpi"]["tier_distribution"];
  readonly degradation_reasons: KpiPayload["kpi"]["degradation_reasons"];
  readonly report_side_effects: LongMemEvalReportSideEffectSummary | null;
  readonly scored_recall_evidence: LongMemEvalRecallEvidenceSummary | null;
}

export interface LongMemEvalArchiveDelta {
  readonly r_at_1: number;
  readonly r_at_5: number;
  readonly r_at_10: number;
  readonly tier_distribution: KpiPayload["kpi"]["tier_distribution"];
  readonly degradation_reasons: KpiPayload["kpi"]["degradation_reasons"];
  readonly report_side_effects: {
    readonly recalls_edge_count: number | null;
    readonly path_relations_total: number | null;
    readonly memory_graph_edges_total: number | null;
  };
  readonly scored_recall_evidence: {
    readonly graph_support_gold_count: number | null;
    readonly path_plasticity_gold_count: number | null;
    readonly graph_expansion_plane_count: number | null;
    readonly path_expansion_plane_count: number | null;
    readonly graph_expansion_plane_count_per_hop: readonly [number | null, number | null];
    readonly graph_expansion_plane_count_per_edge_type: {
      readonly derives_from: number | null;
      readonly recalls: number | null;
      readonly supports: number | null;
    };
  };
  readonly hit_at_5_flips: {
    readonly compared_count: number;
    readonly gained: number;
    readonly lost: number;
  };
}

export interface LatestLongMemEvalArchive {
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly evidence: LongMemEvalArchiveEvidenceSummary;
}

export interface LongMemEvalColdWarmComparisonSidecar {
  readonly schema_version: 1;
  readonly comparison: "cold-none-vs-warm-mixed";
  readonly bench_name: "public";
  readonly split: string;
  readonly policy_shape: BenchPolicyShape;
  readonly current: LongMemEvalArchiveComparisonEntry;
  readonly opposite: LongMemEvalArchiveComparisonEntry | null;
  readonly delta_current_minus_opposite: LongMemEvalArchiveDelta | null;
  readonly note: string | null;
}

export function archiveEvidenceFromDiagnostics(
  diagnostics: LongMemEvalDiagnosticsSidecar | null
): LongMemEvalArchiveEvidenceSummary {
  if (diagnostics === null) {
    return {
      report_side_effects: null,
      scored_recall_evidence: null
    };
  }

  const scoredRecallEvidence =
    diagnostics.scored_recall_evidence ??
    (Array.isArray((diagnostics as { readonly questions?: unknown }).questions)
      ? summarizeLongMemEvalRecallEvidence(diagnostics.questions)
      : null);

  return {
    report_side_effects: diagnostics.report_side_effects ?? null,
    scored_recall_evidence:
      scoredRecallEvidence === null
        ? null
        : normalizeRecallEvidenceSummary(scoredRecallEvidence)
  };
}

export async function readLongMemEvalDiagnosticsSidecar(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string
): Promise<LongMemEvalDiagnosticsSidecar | null> {
  const diagnosticsPath = path.join(
    layout.historyRoot,
    benchName,
    slug,
    LONGMEMEVAL_DIAGNOSTICS_FILENAME
  );
  try {
    const raw = await readFile(diagnosticsPath, "utf8");
    const parsed = JSON.parse(raw) as LongMemEvalDiagnosticsSidecar;
    return await resolveExternalDiagnosticsArtifact(diagnosticsPath, parsed);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function resolveExternalDiagnosticsArtifact(
  diagnosticsPath: string,
  diagnostics: LongMemEvalDiagnosticsSidecar
): Promise<LongMemEvalDiagnosticsSidecar> {
  const compact = diagnostics as {
    readonly compact_schema_version?: unknown;
    readonly full_diagnostics_artifact_path?: unknown;
  };
  if (
    compact.compact_schema_version !== 1 ||
    typeof compact.full_diagnostics_artifact_path !== "string"
  ) {
    return diagnostics;
  }
  const artifactPath = path.isAbsolute(compact.full_diagnostics_artifact_path)
    ? compact.full_diagnostics_artifact_path
    : path.resolve(
        path.dirname(diagnosticsPath),
        compact.full_diagnostics_artifact_path
      );
  if (artifactPath === diagnosticsPath) {
    return diagnostics;
  }
  try {
    return JSON.parse(
      await readFile(artifactPath, "utf8")
    ) as LongMemEvalDiagnosticsSidecar;
  } catch (error) {
    if (isNotFound(error)) {
      return diagnostics;
    }
    throw error;
  }
}

export async function readLatestLongMemEvalOppositeArchive(input: {
  readonly layout: HistoryLayout;
  readonly current: KpiPayload;
}): Promise<LatestLongMemEvalArchive | null> {
  const currentMode = input.current.simulate_report ?? "none";
  const oppositeMode = oppositeColdWarmMode(currentMode);
  if (oppositeMode === null) {
    return null;
  }

  const policyShape = input.current.policy_shape ?? "stress";
  const slugs = await listEntries(input.layout, "public");
  for (let i = slugs.length - 1; i >= 0; i -= 1) {
    const slug = slugs[i];
    if (slug === undefined) continue;
    const payload = await readEntryForDiff(input.layout, "public", slug);
    if (
      payload !== null &&
      payload.split === input.current.split &&
      payload.embedding_provider === input.current.embedding_provider &&
      (payload.policy_shape ?? "stress") === policyShape &&
      (payload.simulate_report ?? "none") === oppositeMode
    ) {
      const diagnostics = await readLongMemEvalDiagnosticsSidecar(
        input.layout,
        "public",
        slug
      );
      return {
        slug,
        payload,
        evidence: archiveEvidenceFromDiagnostics(diagnostics)
      };
    }
  }
  return null;
}

export function buildLongMemEvalColdWarmComparisonSidecar(input: {
  readonly currentSlug: string | null;
  readonly current: KpiPayload;
  readonly currentEvidence: LongMemEvalArchiveEvidenceSummary;
  readonly opposite: LatestLongMemEvalArchive | null;
}): LongMemEvalColdWarmComparisonSidecar {
  const currentMode = input.current.simulate_report ?? "none";
  const policyShape = input.current.policy_shape ?? "stress";
  const oppositeMode = oppositeColdWarmMode(currentMode);
  const current = toComparisonEntry(
    input.currentSlug,
    input.current,
    input.currentEvidence
  );
  const opposite =
    input.opposite === null
      ? null
      : toComparisonEntry(
          input.opposite.slug,
          input.opposite.payload,
          input.opposite.evidence
        );
  const delta =
    input.opposite === null
      ? null
      : buildDelta(
          input.current,
          input.currentEvidence,
          input.opposite.payload,
          input.opposite.evidence
        );

  return {
    schema_version: 1,
    comparison: "cold-none-vs-warm-mixed",
    bench_name: "public",
    split: input.current.split,
    policy_shape: policyShape,
    current,
    opposite,
    delta_current_minus_opposite: delta,
    note:
      oppositeMode === null
        ? `simulate_report=${currentMode} is outside the cold-none/warm-mixed comparison pair`
        : opposite === null
          ? `No prior same split/policy/embedding_provider simulate_report=${oppositeMode} archive found`
          : null
  };
}

export function renderLongMemEvalColdWarmComparisonSidecar(
  sidecar: LongMemEvalColdWarmComparisonSidecar
): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}
