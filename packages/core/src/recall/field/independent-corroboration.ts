import type { CandidateCoverageReceipt } from
  "../delivery/fine-assessment-selection/coverage-atoms.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from "./field-identity.js";
import { compareText } from "../../shared/compare-text.js";

export const INDEPENDENT_EVIDENCE_CORROBORATION_OPERATOR_ID =
  "independent_evidence_corroboration_v1";

export type IndependentEvidenceCorroborationReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof INDEPENDENT_EVIDENCE_CORROBORATION_OPERATOR_ID;
  readonly candidate_key: string;
  readonly configuration_digest: RecallFieldDigest;
  readonly support_cap: number;
  readonly support_score: number;
  readonly refutation: Readonly<{
    readonly state: "not_observed";
    readonly score: null;
  }>;
  readonly sources: readonly Readonly<{
    readonly independence_key: string;
    readonly atom_ids: readonly string[];
    readonly strength: number;
    readonly weight: number;
    readonly contribution: number;
  }>[];
}>;

export function computeIndependentEvidenceCorroboration(params: Readonly<{
  readonly coverage: Readonly<CandidateCoverageReceipt>;
  readonly support_cap: number;
  readonly source_weights?: Readonly<Record<string, number>>;
}>): IndependentEvidenceCorroborationReceipt {
  assertUnit(params.support_cap, "support cap");
  const weightEntries = Object.entries(params.source_weights ?? {})
    .sort(([left], [right]) => compareText(left, right));
  for (const [source, weight] of weightEntries) {
    if (source.length === 0 || source.trim() !== source) {
      throw new Error("source weight key must be a canonical identity");
    }
    assertNonNegative(weight, "source weight");
  }
  const sourceWeights = Object.freeze(Object.fromEntries(weightEntries));
  const grouped = new Map<string, { strength: number; atomIds: string[] }>();
  for (const atom of params.coverage.atoms) {
    if (atom.kind !== "independent_evidence") continue;
    const current = grouped.get(atom.independence_key) ?? { strength: 0, atomIds: [] };
    current.strength = Math.max(
      current.strength,
      assertUnit(atom.strength, "Evidence atom strength")
    );
    current.atomIds.push(atom.atom_id);
    grouped.set(atom.independence_key, current);
  }
  const sources = [...grouped].sort(([left], [right]) => compareText(left, right))
    .map(([independenceKey, source]) => {
      const weight = sourceWeights[independenceKey] ?? 1;
      assertNonNegative(weight, "source weight");
      return Object.freeze({
        independence_key: independenceKey,
        atom_ids: Object.freeze([...new Set(source.atomIds)].sort(compareText)),
        strength: source.strength,
        weight,
        contribution: weight * source.strength
      });
    });
  const support = sources.reduce((sum, source) => sum + source.contribution, 0);
  return Object.freeze({
    schema_version: 1,
    operator_id: INDEPENDENT_EVIDENCE_CORROBORATION_OPERATOR_ID,
    candidate_key: params.coverage.candidate_key,
    configuration_digest: digestRecallFieldIdentity({
      support_cap: params.support_cap,
      source_weights: sourceWeights
    }),
    support_cap: params.support_cap,
    support_score: Math.min(params.support_cap, support),
    refutation: Object.freeze({ state: "not_observed", score: null }),
    sources: Object.freeze(sources)
  });
}

function assertUnit(value: number, field: string): number {
  assertNonNegative(value, field);
  if (value > 1) throw new Error(`${field} must be at most one`);
  return value;
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
}
