import {
  EvidenceSearchProjectionSchema,
  parseVerifiedUserAssertionSourceHash,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationProposal,
  type EvidenceSearchProjection,
  type FactorIncidencePort,
  type FieldContractSha256,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationProposal,
  type SourceAdmissionPort,
  type SourceAdmissionRequest,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../semantic/open-semantic-factor-formation.js";
import { CoreError } from "../../shared/errors.js";
import { materializeEvidenceFactFrameFormation } from
  "../evidence-fact-frame-formation.js";
import type { EvidenceFactFrameProposalNormalizer } from
  "../fact-frame-formation/declarative-normalizer.js";
import type { OpenSemanticFactorExtractionPort } from
  "../../semantic/open-semantic-factor-extraction-port.js";
import { emitDeterministicIncidences } from "./factor-emit.js";
import {
  persistSemanticFormationReceipt,
  persistDescriptors,
  persistIncidences
} from "./factor-incidence.js";
import type { FieldFormationStores } from "./field-stores.js";
import { resolveSourceLineageId } from "./source-admission.js";
import {
  deriveAddressableSpanViews,
  sourceSpanFromCodeUnitOffsets,
  type SourceSpanDraft
} from "./source-span-views.js";

export interface EvidenceFormationPlan {
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
  readonly factFrameCapture: Readonly<EvidenceFactFrameFormationCapture>;
  readonly semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
}

export interface EvidenceFieldFormationPorts {
  readonly sha256?: FieldContractSha256;
  readonly sourceAdmission?: SourceAdmissionPort;
  readonly factorIncidence?: FactorIncidencePort;
  readonly fieldStores?: FieldFormationStores;
  readonly semanticExtractor?: OpenSemanticFactorExtractionPort;
}

export function planEvidenceFormation(input: Readonly<{
  readonly evidence: Readonly<EvidenceCapsule>;
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
  readonly factFrameProposal?: Readonly<EvidenceFactFrameFormationProposal>;
  readonly semanticFactorProposal?: Readonly<OpenSemanticFactorFormationProposal>;
  readonly factFrameProposalNormalizer?: Readonly<EvidenceFactFrameProposalNormalizer> | null;
}> & EvidenceFieldFormationPorts): EvidenceFormationPlan {
  return planFormationViews(input);
}

export function admitEvidenceFieldFormation(
  input: Readonly<{
    readonly evidence: Readonly<EvidenceCapsule>;
    readonly views: EvidenceFormationPlan;
  }> & EvidenceFieldFormationPorts
): SourceRecordIdentity | null {
  return tryPlanFieldFormation(input, input.views);
}

function planFormationViews(input: Readonly<{
  readonly evidence: Readonly<EvidenceCapsule>;
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
  readonly factFrameProposal?: Readonly<EvidenceFactFrameFormationProposal>;
  readonly semanticFactorProposal?: Readonly<OpenSemanticFactorFormationProposal>;
  readonly factFrameProposalNormalizer?: Readonly<EvidenceFactFrameProposalNormalizer> | null;
}>): EvidenceFormationPlan {
  const supplied = input.searchProjections.map((projection) =>
    EvidenceSearchProjectionSchema.parse(projection)
  );
  assertCallerSearchProjectionAuthority(supplied);
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

function assertCallerSearchProjectionAuthority(
  projections: readonly Readonly<EvidenceSearchProjection>[]
): void {
  if (projections.some(({ projection_kind: kind }) => kind === "fact_key")) {
    throw new CoreError(
      "VALIDATION",
      "Fact-key projections must come from canonical fact-frame formation"
    );
  }
}

function tryPlanFieldFormation(
  input: Readonly<{
    readonly evidence: Readonly<EvidenceCapsule>;
  }> & EvidenceFieldFormationPorts,
  views: EvidenceFormationPlan
): SourceRecordIdentity | null {
  const sha256 = input.sha256;
  const sourceAdmission = input.sourceAdmission;
  const factorIncidence = input.factorIncidence;
  const fieldStores = input.fieldStores;
  if (
    sha256 === undefined ||
    sourceAdmission === undefined ||
    factorIncidence === undefined ||
    fieldStores === undefined
  ) {
    return null;
  }
  return applyFieldFormation({
    evidence: input.evidence,
    views,
    sha256,
    sourceAdmission,
    factorIncidence,
    fieldStores
  });
}

function applyFieldFormation(input: Readonly<{
  readonly evidence: Readonly<EvidenceCapsule>;
  readonly views: EvidenceFormationPlan;
  readonly sha256: FieldContractSha256;
  readonly sourceAdmission: SourceAdmissionPort;
  readonly factorIncidence: FactorIncidencePort;
  readonly fieldStores: FieldFormationStores;
}>): SourceRecordIdentity {
  const source = input.fieldStores.runAtomic(() => persistMinimumSource(input));
  input.fieldStores.runAtomic(() => persistFactorFormation(input, source));
  return source.record;
}

type MinimumSourceFormation = Readonly<{
  readonly request: SourceAdmissionRequest;
  readonly record: SourceRecordIdentity;
  readonly spans: ReturnType<SourceAdmissionPort["admit"]>["spans"];
}>;

function persistMinimumSource(
  input: Parameters<typeof applyFieldFormation>[0]
): MinimumSourceFormation {
  const request = sourceRequestFromEvidence(input.evidence, input.views);
  const admitted = input.sourceAdmission.admit(request);
  return Object.freeze({ request, record: admitted.record, spans: admitted.spans });
}

function persistFactorFormation(
  input: Parameters<typeof applyFieldFormation>[0],
  source: MinimumSourceFormation
): void {
  const request = source.request;
  const emitted = emitDeterministicIncidences({
    sha256: input.sha256,
    recorded_at: input.evidence.created_at,
    workspace_id: input.evidence.workspace_id,
    scope: input.evidence.workspace_id,
    source_id: request.source_id,
    source_version: request.source_version,
    content_bytes: request.content_bytes,
    actor: input.evidence.created_by,
    event_time: request.event_time,
    valid_from: request.valid_from,
    valid_to: request.valid_to,
    spans: source.spans,
    factFrameSlots: input.views.factFrameCapture.fact_frame?.slots ?? [],
    semanticSurfaces: semanticSurfacesOf(input.views.semanticFormation)
  });
  persistDescriptors(input.fieldStores, emitted.factors);
  persistIncidences(input.factorIncidence, emitted.incidences);
  persistSemanticFormationReceipt({
    sha256: input.sha256,
    incidence: input.factorIncidence,
    workspace_id: input.evidence.workspace_id,
    evidence_object_id: input.evidence.object_id,
    recorded_at: input.evidence.created_at,
    capture: input.views.semanticFormation
  });
}

function sourceRequestFromEvidence(
  evidence: Readonly<EvidenceCapsule>,
  views: EvidenceFormationPlan
): SourceAdmissionRequest {
  const content = evidence.excerpt ?? evidence.gist;
  return {
    workspace_id: evidence.workspace_id,
    source_id: resolveSourceLineageId({
      object_id: evidence.object_id,
      source_hash: evidence.source_hash,
      artifact_ref: evidence.physical_anchor?.artifact_ref ?? null
    }),
    source_version: "1",
    content_bytes: content,
    evidence_object_id: evidence.object_id,
    recorded_at: evidence.created_at,
    event_time: evidence.event_anchor?.occurred_at ?? null,
    valid_from: null,
    valid_to: null,
    spans: collectAdmissionSpans(content, views)
  };
}

function collectAdmissionSpans(
  content: string,
  views: EvidenceFormationPlan
): readonly SourceSpanDraft[] {
  return Object.freeze([
    ...deriveAddressableSpanViews(content),
    ...proposedSemanticSpans(content, views.semanticFormation)
  ]);
}

function proposedSemanticSpans(
  content: string,
  semantic: Readonly<OpenSemanticFactorFormationCapture>
): readonly SourceSpanDraft[] {
  const graph = semantic.graph;
  if (graph === null) return Object.freeze([]);
  const drafts: SourceSpanDraft[] = [];
  for (const factor of graph.factors) {
    const [start, end] = factor.source_span;
    try {
      drafts.push(sourceSpanFromCodeUnitOffsets(content, {
        start_offset: start,
        end_offset: end,
        purpose: "proposed_subspan"
      }));
    } catch {
      continue;
    }
  }
  return drafts;
}

function semanticSurfacesOf(
  semantic: Readonly<OpenSemanticFactorFormationCapture>
): readonly string[] {
  const graph = semantic.graph;
  if (graph === null) return Object.freeze([]);
  return Object.freeze(graph.factors.map((factor) => factor.surface));
}
