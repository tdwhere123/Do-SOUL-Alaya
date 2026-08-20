import { createHash } from "node:crypto";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  EvidenceFactFrameFormationCaptureSchema,
  EvidenceFactFrameFormationProposalSchema,
  buildAssociativeFactKeyProjections,
  evidenceFactFrameFormationCapturePreimage,
  groundAssociativeFactFrame,
  verifyEvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCaptureBody,
  type EvidenceFactFrameFormationProposal,
  type EvidenceFactFrameFormationStatus,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import type { EvidenceFactFrameProposalNormalizer } from
  "./fact-frame-formation/declarative-normalizer.js";

export type MaterializedEvidenceFactFrameFormation = Readonly<{
  readonly capture: Readonly<EvidenceFactFrameFormationCapture>;
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
}>;

export function materializeEvidenceFactFrameFormation(params: Readonly<{
  readonly sourceAssertion: string | null;
  readonly sourceHash: string | null;
  readonly proposal?: Readonly<EvidenceFactFrameFormationProposal>;
  readonly normalizer?: Readonly<EvidenceFactFrameProposalNormalizer> | null;
}>): MaterializedEvidenceFactFrameFormation {
  const assertion = normalizeText(params.sourceAssertion);
  const sourceHash = normalizeText(params.sourceHash);
  if (assertion === null || sourceHash === null) {
    return emptyFormation("ineligible", sourceHash, null);
  }
  const normalized = params.proposal === undefined
    ? proposeWithNormalizer(assertion, params.normalizer)
    : Object.freeze({
      proposal: params.proposal,
      expectedProducer: null,
      emptyStatus: "unavailable" as const
    });
  if (normalized.proposal === undefined) {
    return emptyFormation(normalized.emptyStatus, sourceHash, normalized.expectedProducer);
  }
  const parsed = EvidenceFactFrameFormationProposalSchema.safeParse(normalized.proposal);
  const producer = readProducerOperatorId(normalized.proposal);
  if (!parsed.success || parsed.data.source_assertion !== assertion) {
    return emptyFormation("rejected", sourceHash, normalized.expectedProducer ?? producer);
  }
  if (normalized.expectedProducer !== null &&
      parsed.data.producer_operator_id !== normalized.expectedProducer) {
    return emptyFormation("rejected", sourceHash, normalized.expectedProducer);
  }
  const frame = groundAssociativeFactFrame(parsed.data.fact_frame, assertion);
  if (frame === null) {
    return emptyFormation("rejected", sourceHash, parsed.data.producer_operator_id);
  }
  const capture = createCapture({
    schema_version: 1,
    operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "formed",
    producer_operator_id: parsed.data.producer_operator_id,
    source_hash: sourceHash,
    fact_frame: frame
  });
  return Object.freeze({
    capture,
    searchProjections: buildAssociativeFactKeyProjections(frame)
  });
}

function proposeWithNormalizer(
  assertion: string,
  configured: Readonly<EvidenceFactFrameProposalNormalizer> | null | undefined
): Readonly<{
  readonly proposal: Readonly<EvidenceFactFrameFormationProposal> | undefined;
  readonly expectedProducer: string | null;
  readonly emptyStatus: "unavailable" | "rejected";
}> {
  if (configured === null || configured === undefined) {
    return Object.freeze({
      proposal: undefined,
      expectedProducer: null,
      emptyStatus: "unavailable"
    });
  }
  const producer = normalizeProducerId(configured.operator_id);
  if (producer === null) {
    return Object.freeze({
      proposal: undefined,
      expectedProducer: null,
      emptyStatus: "rejected"
    });
  }
  try {
    return Object.freeze({
      proposal: configured.propose(assertion),
      expectedProducer: producer,
      emptyStatus: "unavailable"
    });
  } catch {
    return Object.freeze({
      proposal: undefined,
      expectedProducer: producer,
      emptyStatus: "rejected"
    });
  }
}

export function replayEvidenceFactFrameFormationCapture(params: Readonly<{
  readonly sourceAssertion: string | null;
  readonly sourceHash: string | null;
  readonly capture: unknown;
}>): MaterializedEvidenceFactFrameFormation {
  const capture = verifyEvidenceFactFrameFormationCapture(params.capture, sha256);
  const sourceHash = normalizeText(params.sourceHash);
  if (capture.source_hash !== null && capture.source_hash !== sourceHash) {
    throw new Error("fact-frame formation capture source hash mismatch");
  }
  if (capture.status !== "formed" || capture.fact_frame === null) {
    return Object.freeze({ capture, searchProjections: Object.freeze([]) });
  }
  const assertion = normalizeText(params.sourceAssertion);
  if (assertion === null || sourceHash === null ||
      groundAssociativeFactFrame(capture.fact_frame, assertion) === null) {
    throw new Error("formed fact-frame capture is not grounded in its evidence assertion");
  }
  return Object.freeze({
    capture,
    searchProjections: buildAssociativeFactKeyProjections(capture.fact_frame)
  });
}

function emptyFormation(
  status: Exclude<EvidenceFactFrameFormationStatus, "formed">,
  sourceHash: string | null,
  producerOperatorId: string | null
): MaterializedEvidenceFactFrameFormation {
  return Object.freeze({
    capture: createCapture({
      schema_version: 1,
      operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
      status,
      producer_operator_id: producerOperatorId,
      source_hash: sourceHash,
      fact_frame: null
    }),
    searchProjections: Object.freeze([])
  });
}

function createCapture(
  body: Readonly<EvidenceFactFrameFormationCaptureBody>
): EvidenceFactFrameFormationCapture {
  return EvidenceFactFrameFormationCaptureSchema.parse(Object.freeze({
    ...body,
    capture_digest: `sha256:${sha256(
      evidenceFactFrameFormationCapturePreimage(body)
    )}`
  }));
}

function readProducerOperatorId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return normalizeProducerId((value as Record<string, unknown>).producer_operator_id);
}

function normalizeProducerId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 &&
    value.trim().length <= 128
    ? value.trim()
    : null;
}

function normalizeText(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
