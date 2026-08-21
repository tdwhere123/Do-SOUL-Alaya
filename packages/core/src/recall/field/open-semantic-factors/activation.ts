import {
  type OpenSemanticFactorActivationState,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
export {
  OPEN_SEMANTIC_FACTOR_ACTIVATION_STATES,
  type OpenSemanticFactorActivationState
} from "@do-soul/alaya-protocol";
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
  readonly state: OpenSemanticFactorActivationState;
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
  readonly evidence_formations?: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
}>): OpenSemanticFactorActivationReceipt {
  const composition = verifyOpenSemanticFactorComposition({
    receipt: params.composition,
    trace: params.trace,
    query_capture: params.query_capture,
    evidence_formations: params.evidence_formations
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
  readonly evidence_formations?: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
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

export function resolveJoinActivation(
  own: number | undefined,
  constraint: number | undefined,
  constraintReceiptMatched: boolean
): number | null {
  if (constraintReceiptMatched) return own === undefined ? null : own;
  return constraint === undefined ? null : constraint;
}

function buildActivationEntries(
  composition: Readonly<OpenSemanticFactorCompositionReceipt>,
  trace: Readonly<OpenSemanticFactorCompatibilityTrace>
): readonly Readonly<OpenSemanticFactorActivationObservation>[] {
  const receiptByEvidenceId = new Map(
    trace.entries.map((entry) => [entry.evidence_id, entry.receipt] as const)
  );
  const fractionByEvidenceId = new Map(
    [...receiptByEvidenceId].flatMap(([evidenceId, receipt]) => {
      const fraction = compatibilityFraction(receipt);
      return fraction > 0 ? [[evidenceId, fraction] as const] : [];
    })
  );
  const supportByEvidenceId = buildEvidenceSupportMap(composition);
  return Object.freeze([...supportByEvidenceId]
    .sort(([left], [right]) => compareText(left, right))
    .flatMap(([evidenceId, support]) => {
      const receiptMatched = constraintReceiptMatched(
        receiptByEvidenceId.get(evidenceId)
      );
      const activation = resolveJoinActivation(
        fractionByEvidenceId.get(evidenceId),
        inheritedConstraintFraction(
          evidenceId, composition, receiptByEvidenceId, fractionByEvidenceId
        ),
        receiptMatched
      );
      return activation === null ? [] : [Object.freeze({
        evidence_id: evidenceId,
        state: receiptMatched ? "observed" as const : "reconstructed" as const,
        activation,
        solution_count: support.solutionCount,
        proposition_match_count: support.propositionMatches.size
      })];
    }));
}

function buildEvidenceSupportMap(
  composition: Readonly<OpenSemanticFactorCompositionReceipt>
) {
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
  return supportByEvidenceId;
}

function constraintReceiptMatched(
  receipt: OpenSemanticFactorCompatibilityTrace["entries"][number]["receipt"] | undefined
): boolean {
  return receipt !== undefined &&
    (receipt.status === "compatible" || receipt.matched_query_proposition_count > 0);
}

function inheritedConstraintFraction(
  evidenceId: string,
  composition: Readonly<OpenSemanticFactorCompositionReceipt>,
  receiptByEvidenceId: ReadonlyMap<
    string,
    OpenSemanticFactorCompatibilityTrace["entries"][number]["receipt"]
  >,
  fractionByEvidenceId: ReadonlyMap<string, number>
): number | undefined {
  const inherited: number[] = [];
  for (const solution of composition.solutions) {
    if (!solution.evidence_ids.includes(evidenceId)) continue;
    for (const otherId of solution.evidence_ids) {
      if (otherId === evidenceId) continue;
      if (!constraintReceiptMatched(receiptByEvidenceId.get(otherId))) continue;
      const fraction = fractionByEvidenceId.get(otherId);
      if (fraction !== undefined) inherited.push(fraction);
    }
  }
  if (inherited.length === 0) return undefined;
  const [first, ...rest] = inherited;
  if (first === undefined || rest.some((value) => value !== first)) return undefined;
  return first;
}

function compatibilityFraction(
  receipt: Readonly<OpenSemanticFactorCompatibilityTrace["entries"][number]["receipt"]>
): number {
  if (receipt.query_proposition_count <= 0) return 0;
  return receipt.matched_query_proposition_count / receipt.query_proposition_count;
}
