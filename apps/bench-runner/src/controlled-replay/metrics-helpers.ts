import type {
  CandidateDiagnostic,
  NativeHealthGate,
  ScenarioArchive,
  ScenarioLabel,
  ScenarioMetrics
} from "./types.js";

export function minNativeHealthGate(
  id: NativeHealthGate["id"],
  label: string,
  current: number | null,
  target: number
): NativeHealthGate {
  return {
    id,
    label,
    current,
    target,
    direction: "min",
    passed: current !== null && current >= target,
    missing: current === null
  };
}

export function computeQuestionRankGain(
  coldRanks: Readonly<Record<string, number | null>> | null,
  warmRanks: Readonly<Record<string, number | null>> | null,
  questionId: string
): number | null {
  if (
    coldRanks === null ||
    warmRanks === null ||
    !(questionId in coldRanks) ||
    !(questionId in warmRanks)
  ) {
    return null;
  }
  return round(rankOrMissPenalty(coldRanks[questionId]) - rankOrMissPenalty(warmRanks[questionId]));
}

export function rankOrMissPenalty(rank: number | null | undefined): number {
  return rank === null || rank === undefined ? 11 : rank;
}

export function metricsFor(
  scenarios: readonly ScenarioArchive[],
  label: ScenarioLabel
): ScenarioMetrics | undefined {
  return scenarios.find((scenario) => scenario.label === label)?.metrics;
}

export function readCandidateDiagnostics(raw: unknown): readonly CandidateDiagnostic[] {
  if (raw === null || typeof raw !== "object") return [];
  const source = (raw as { readonly candidates?: unknown }).candidates;
  if (!Array.isArray(source)) return [];
  return source.flatMap((item): CandidateDiagnostic[] => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const objectId = readString(record.object_id);
    if (objectId === null) return [];
    return [{
      object_id: objectId,
      pre_budget_rank: readNumber(record.pre_budget_rank),
      fused_rank: readNumber(record.fused_rank),
      final_rank: readNumber(record.final_rank),
      dropped_reason: readString(record.dropped_reason),
      lexical_rank: readNumber(record.lexical_rank),
      fused_rank_contribution_per_stream:
        readNumberRecord(record.fused_rank_contribution_per_stream),
      admission_planes: readStringArray(record.admission_planes),
      source_channels: readStringArray(record.source_channels)
    }];
  });
}

export function emptyRankDistribution(): Record<string, number> {
  return { "1": 0, "2": 0, "3": 0, "4-5": 0, "6-10": 0, miss: 0 };
}

export function rankBucket(rank: number | null): string {
  if (rank === 1) return "1";
  if (rank === 2) return "2";
  if (rank === 3) return "3";
  if (rank !== null && rank >= 4 && rank <= 5) return "4-5";
  if (rank !== null && rank >= 6 && rank <= 10) return "6-10";
  return "miss";
}

export function hasEvidenceStreamContribution(diagnostic: CandidateDiagnostic): boolean {
  return (
    diagnostic.admission_planes.includes("evidence_anchor") ||
    diagnostic.admission_planes.includes("evidence_fts") ||
    diagnostic.source_channels.includes("evidence_anchor") ||
    diagnostic.source_channels.includes("evidence_fts") ||
    diagnostic.source_channels.includes("plane:evidence_anchor") ||
    diagnostic.source_channels.includes("plane:evidence_fts") ||
    (diagnostic.fused_rank_contribution_per_stream.evidence_fts ?? 0) > 0 ||
    (diagnostic.fused_rank_contribution_per_stream.evidence_structural_agreement ?? 0) > 0 ||
    (diagnostic.fused_rank_contribution_per_stream.source_evidence_agreement ?? 0) > 0
  );
}

export function hasPathStreamContribution(diagnostic: CandidateDiagnostic): boolean {
  return (
    diagnostic.admission_planes.includes("path_expansion") ||
    diagnostic.source_channels.includes("path_expansion") ||
    diagnostic.source_channels.includes("plane:path_expansion") ||
    (diagnostic.fused_rank_contribution_per_stream.path_expansion ?? 0) > 0
  );
}

export function absDelta(left: number | null | undefined, right: number | null | undefined): number {
  if (left === null || left === undefined || right === null || right === undefined) {
    return 0;
  }
  return Math.abs(left - right);
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readNumberRecord(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entryValue]) => {
        const numberValue = readNumber(entryValue);
        return numberValue === null ? [] : [[key, numberValue] as const];
      })
    )
  );
}

export function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round(numerator / denominator);
}
