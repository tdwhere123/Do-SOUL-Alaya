import {
  EvidenceSearchProjectionSchema,
  parseVerifiedUserAssertionSourceHash,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationProposal,
  type EvidenceSearchProjection,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationProposal
} from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../semantic/open-semantic-factor-formation.js";
import { CoreError } from "../../shared/errors.js";
import { materializeEvidenceFactFrameFormation } from
  "../evidence-fact-frame-formation.js";
import type { EvidenceFactFrameProposalNormalizer } from
  "../fact-frame-formation/declarative-normalizer.js";

export interface EvidenceFormationPlan {
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
  readonly factFrameCapture: Readonly<EvidenceFactFrameFormationCapture>;
  readonly semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
}

export function planEvidenceFormation(input: Readonly<{
  readonly evidence: Readonly<EvidenceCapsule>;
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
  readonly factFrameProposal?: Readonly<EvidenceFactFrameFormationProposal>;
  readonly semanticFactorProposal?: Readonly<OpenSemanticFactorFormationProposal>;
  readonly factFrameProposalNormalizer?: Readonly<EvidenceFactFrameProposalNormalizer> | null;
}>): EvidenceFormationPlan {
  const supplied = input.searchProjections.map((projection) =>
    EvidenceSearchProjectionSchema.parse(projection)
  );
  if (supplied.some(({ projection_kind: kind }) => kind === "fact_key")) {
    throw new CoreError(
      "VALIDATION",
      "Fact-key projections must come from canonical fact-frame formation"
    );
  }
  const factFrame = materializeEvidenceFactFrameFormation({
    sourceAssertion: input.evidence.excerpt,
    sourceHash: input.evidence.source_hash,
    normalizer: parseVerifiedUserAssertionSourceHash(input.evidence.source_hash) === null
      ? null
      : input.factFrameProposalNormalizer,
    ...(input.factFrameProposal === undefined ? {} : { proposal: input.factFrameProposal })
  });
  return {
    searchProjections: Object.freeze([...supplied, ...factFrame.searchProjections]),
    factFrameCapture: factFrame.capture,
    semanticFormation: materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: input.evidence.excerpt,
      ...(input.semanticFactorProposal === undefined
        ? {}
        : { proposal: input.semanticFactorProposal })
    })
  };
}
