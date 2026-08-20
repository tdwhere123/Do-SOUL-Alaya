import type { OpenSemanticFactorFormationCapture } from
  "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import type { OpenSemanticFactorCompatibilityTrace } from
  "./compatibility-trace.js";
import {
  verifyOpenSemanticFactorComposition,
  type OpenSemanticFactorCompositionReceipt
} from "./composition.js";
import { compareText } from "../../../shared/compare-text.js";

export const OPEN_SEMANTIC_FACTOR_ACTIVATION_OPERATOR_ID =
  "open_semantic_solution_membership_activation_v2";

export type OpenSemanticFactorActivationObservation = Readonly<{
  readonly evidence_id: string;
  readonly state: "observed";
  readonly activation: number;
  readonly solution_count: number;
  readonly proposition_match_count: number;
}>;

export type OpenSemanticFactorActivationReceipt = Readonly<{
  readonly schema_version: 2;
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_ACTIVATION_OPERATOR_ID;
  readonly status: OpenSemanticFactorCompositionReceipt["status"];
  readonly composition_receipt_digest: RecallFieldDigest;
  readonly entry_count: number;
  readonly truncated: boolean;
  readonly entries: readonly Readonly<OpenSemanticFactorActivationObservation>[];
  readonly missing_evidence_policy: "no_op";
  readonly ranking_effect: "candidate_attribution";
  readonly receipt_digest: RecallFieldDigest;
}>;

export function materializeOpenSemanticFactorActivation(params: Readonly<{
  readonly composition: Readonly<OpenSemanticFactorCompositionReceipt>;
  readonly trace: Readonly<OpenSemanticFactorCompatibilityTrace>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorActivationReceipt {
  const composition = verifyOpenSemanticFactorComposition({
    receipt: params.composition,
    trace: params.trace,
    query_capture: params.query_capture
  });
  const entries = buildActivationEntries(composition, params.trace);
  const body = Object.freeze({
    schema_version: 2 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_ACTIVATION_OPERATOR_ID,
    status: composition.status,
    composition_receipt_digest: composition.receipt_digest,
    entry_count: entries.length,
    truncated: composition.truncated,
    entries,
    missing_evidence_policy: "no_op" as const,
    ranking_effect: "candidate_attribution" as const
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyOpenSemanticFactorActivation(params: Readonly<{
  readonly activation: Readonly<OpenSemanticFactorActivationReceipt>;
  readonly composition: Readonly<OpenSemanticFactorCompositionReceipt>;
  readonly trace: Readonly<OpenSemanticFactorCompatibilityTrace>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorActivationReceipt {
  const expected = materializeOpenSemanticFactorActivation(params);
  const { receipt_digest: _digest, ...body } = params.activation;
  if (expected.receipt_digest !== params.activation.receipt_digest ||
      digestRecallFieldIdentity(body) !== params.activation.receipt_digest ||
      params.activation.composition_receipt_digest !== params.composition.receipt_digest) {
    throw new Error("open semantic factor activation receipt digest mismatch");
  }
  return params.activation;
}

function buildActivationEntries(
  composition: Readonly<OpenSemanticFactorCompositionReceipt>,
  trace: Readonly<OpenSemanticFactorCompatibilityTrace>
): readonly Readonly<OpenSemanticFactorActivationObservation>[] {
  const fractionByEvidenceId = new Map(
    trace.entries.flatMap((entry) => {
      const fraction = compatibilityFraction(entry.receipt);
      return fraction > 0 ? [[entry.evidence_id, fraction] as const] : [];
    })
  );
  const supportByEvidenceId = new Map<string, {
    solutionCount: number;
    propositionMatches: Set<string>;
  }>();
  for (const solution of composition.solutions) {
    for (const evidenceId of solution.evidence_ids) {
      const support = supportByEvidenceId.get(evidenceId) ?? {
        solutionCount: 0,
        propositionMatches: new Set<string>()
      };
      support.solutionCount += 1;
      for (const match of solution.proposition_matches) {
        if (match.evidence_id !== evidenceId) continue;
        support.propositionMatches.add(
          `${match.query_proposition_id}\0${match.evidence_proposition_id}`
        );
      }
      supportByEvidenceId.set(evidenceId, support);
    }
  }
  return Object.freeze([...supportByEvidenceId]
    .sort(([left], [right]) => compareText(left, right))
    .flatMap(([evidenceId, support]) => {
      const activation = fractionByEvidenceId.get(evidenceId);
      if (activation === undefined) return [];
      return [Object.freeze({
        evidence_id: evidenceId,
        state: "observed" as const,
        activation,
        solution_count: support.solutionCount,
        proposition_match_count: support.propositionMatches.size
      })];
    }));
}

function compatibilityFraction(
  receipt: Readonly<OpenSemanticFactorCompatibilityTrace["entries"][number]["receipt"]>
): number {
  if (receipt.query_proposition_count <= 0) return 0;
  return receipt.matched_query_proposition_count / receipt.query_proposition_count;
}
