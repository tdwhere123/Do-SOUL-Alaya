import type { RecallCandidate, RecallOriginPlane } from "@do-soul/alaya-protocol";
import {
  assertUniqueCandidateField,
  buildRecallCandidateDedupeKey
} from "../recall-service-helpers.js";
import {
  collateCandidatePropositionProvenance,
  type CandidatePropositionProvenanceMap,
  type CompositionView,
  type QueryOsfCompletenessView,
  type QueryOsfFormationView
} from "./candidate-proposition-provenance.js";
import { copyTypedFactFrameReceiptsFromFormations } from
  "./capture-proof/typed-fact-frame-receipts.js";
import { fieldCandidateEvidenceIds } from "../field-candidate-evidence-ids.js";
import type { EvidenceFactFrameFormationCapture } from "@do-soul/alaya-protocol";
import {
  absentLexicalBoundProof,
  type LexicalBoundProof
} from "./lexical-bound-proof.js";
import type { RecallFieldDigest } from "../../field/field-identity.js";
import { unavailableProducerDigest } from "../snapshot-coherence/index.js";

export type CaptureProofDiagnostics = Readonly<{
  readonly lexical_bound_proofs: readonly Readonly<LexicalBoundProof>[];
  readonly candidate_proposition_provenance: CandidatePropositionProvenanceMap;
}>;

type CaptureProofFieldCandidate = Readonly<{
  readonly entry: Readonly<{
    readonly object_id: string;
    readonly evidence_refs: readonly string[];
  }>;
  readonly originPlane?: RecallOriginPlane;
  readonly objectKind?: RecallCandidate["object_kind"];
}>;

type CaptureProofPreparedSource = Readonly<{
  readonly snapshotVector: Readonly<{
    readonly base_store_digest: RecallFieldDigest;
  }>;
  readonly retrievalFieldBundle: Readonly<{
    readonly memoryLexicalBoundProofs: () => readonly Readonly<LexicalBoundProof>[];
    readonly memoryLexicalBoundProofsForSnapshot: (
      snapshotDigest: RecallFieldDigest
    ) => readonly Readonly<LexicalBoundProof>[];
  }>;
}>;

type CaptureProofAssessmentSource = Readonly<{
  readonly supplementaryData: Readonly<{
    readonly queryOpenSemanticFactorFormation?: QueryOsfFormationView | null;
    readonly queryOpenSemanticFactorCompletenessReceipt?: QueryOsfCompletenessView | null;
    readonly openSemanticFactorComposition?: CompositionView | null;
    readonly factFrameFormationsByEvidenceId?: Readonly<
      Record<string, EvidenceFactFrameFormationCapture>
    >;
  }>;
}>;

// invariant: provenance rows key the scored field, not the empty canonical prepared shell.
export function buildCaptureProofDiagnostics(
  prepared: CaptureProofPreparedSource,
  assessment: CaptureProofAssessmentSource,
  fieldCandidates: readonly CaptureProofFieldCandidate[]
): CaptureProofDiagnostics {
  assertUniqueCandidateField(fieldCandidates);
  const candidates = Object.freeze(fieldCandidates.map((candidate) => {
    const evidenceIds = Object.freeze(fieldCandidateEvidenceIds(candidate));
    const copied = copyTypedFactFrameReceiptsFromFormations(
      evidenceIds,
      assessment.supplementaryData.factFrameFormationsByEvidenceId
    );
    return Object.freeze({
      candidate_key: buildRecallCandidateDedupeKey(candidate),
      evidence_ids: evidenceIds,
      ...(copied.receipts === undefined ? {} : { typed_fact_frames: copied.receipts }),
      ...(copied.gap === undefined ? {} : { typed_fact_frame_gap: copied.gap })
    });
  }));
  const proofs = memoryLexicalBoundProofsForPreparedSnapshot(prepared);
  return Object.freeze({
    lexical_bound_proofs: proofs.length > 0
      ? proofs
      : Object.freeze([absentLexicalBoundProof()]),
    candidate_proposition_provenance: collateCandidatePropositionProvenance({
      candidate_keys: candidates.map((candidate) => candidate.candidate_key),
      query_osf_formation:
        assessment.supplementaryData.queryOpenSemanticFactorFormation,
      query_osf_completeness:
        assessment.supplementaryData.queryOpenSemanticFactorCompletenessReceipt,
      open_semantic_factor_composition:
        assessment.supplementaryData.openSemanticFactorComposition,
      candidates
    })
  });
}

function memoryLexicalBoundProofsForPreparedSnapshot(
  prepared: CaptureProofPreparedSource
): readonly Readonly<LexicalBoundProof>[] {
  const baseStoreDigest = prepared.snapshotVector.base_store_digest;
  if (baseStoreDigest === unavailableProducerDigest("base_store")) {
    return prepared.retrievalFieldBundle.memoryLexicalBoundProofs();
  }
  return prepared.retrievalFieldBundle.memoryLexicalBoundProofsForSnapshot(baseStoreDigest);
}
