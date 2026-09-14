import { createHash } from "node:crypto";
import {
  EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
  EvidenceOsfSemanticCompletenessReceiptSchema,
  groundEvidenceFactFrameObligation,
  evidenceOsfSemanticCompletenessPreimage,
  verifyEvidenceOsfSemanticCompleteness,
  type EvidenceFactFrameFormationCapture,
  type OpenSemanticFactorFormationCapture,
  type EvidenceOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
import { compileSourceFrameSemanticGraph } from "@do-soul/alaya-protocol/node/source-frame";
import { materializeOpenSemanticFactorFormation } from "../../semantic/open-semantic-factor-formation.js";

export { EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID } from "@do-soul/alaya-protocol";
export type { EvidenceOsfSemanticCompletenessReceipt } from "@do-soul/alaya-protocol";

export const FACT_FRAME_CANONICAL_OSF_PRODUCER_OPERATOR_ID =
  "core_fact_frame_canonical_open_semantic_factor_v2";

type CompletenessInput = Readonly<{
  sourceText: string;
  factFrame: Readonly<EvidenceFactFrameFormationCapture>;
  semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
}>;

/** A qualified source frame owns formation; nomination failure is retained separately. */
export function certifyEvidenceSemanticCompleteness(input: CompletenessInput): Readonly<{
  semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
  receipt: EvidenceOsfSemanticCompletenessReceipt;
}> {
  const frame = input.factFrame.fact_frame;
  if (input.factFrame.status !== "formed" || frame === null) {
    const upstream = input.semanticFormation;
    const formation = upstream.status === "formed"
      ? materializeOpenSemanticFactorFormation({ source_kind: "evidence", source_text: input.sourceText })
      : upstream;
    return result(input, formation, "not_applicable", "upstream_not_formed", null);
  }
  const graph = compileSourceFrameSemanticGraph(input.sourceText, frame);
  if (graph === null) {
    return result(input, rejectedFormation(input.sourceText), "rejected", "invalid_fact_frame_obligation", null);
  }
  const obligation = groundEvidenceFactFrameObligation(input.sourceText, frame);
  const formation = materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: input.sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: FACT_FRAME_CANONICAL_OSF_PRODUCER_OPERATOR_ID,
      source_text: input.sourceText,
      graph
    }
  });
  if (formation.status !== "formed") {
    return result(input, rejectedFormation(input.sourceText), "rejected", "semantic_graph_incomplete", obligation);
  }
  return result(input, formation, "certified", "complete", obligation);
}

function rejectedFormation(source: string): OpenSemanticFactorFormationCapture {
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence", source_text: source, negative_status: "rejected"
  });
}

function result(
  input: CompletenessInput,
  formation: OpenSemanticFactorFormationCapture,
  status: EvidenceOsfSemanticCompletenessReceipt["status"],
  reason: EvidenceOsfSemanticCompletenessReceipt["reason_code"],
  obligation: ReturnType<typeof groundEvidenceFactFrameObligation>
) {
  const body = {
    schema_version: 1 as const,
    operator_id: EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
    status,
    reason_code: reason,
    fact_frame_capture_digest: input.factFrame.capture_digest,
    semantic_formation_capture_digest: formation.capture_digest,
    predicate: obligation?.predicate ?? null,
    arguments: obligation?.arguments ?? [],
    arity: obligation?.arguments.length ?? null,
    upstream_semantic_formation: input.semanticFormation
  };
  const receipt = EvidenceOsfSemanticCompletenessReceiptSchema.parse({
    ...body,
    receipt_digest: `sha256:${sha256(evidenceOsfSemanticCompletenessPreimage(body))}`
  });
  return Object.freeze({ semanticFormation: formation, receipt });
}

export function verifyEvidenceSemanticCompletenessReceipt(input: Readonly<{
  receipt: Readonly<EvidenceOsfSemanticCompletenessReceipt>;
  sourceText: string;
  factFrame: Readonly<EvidenceFactFrameFormationCapture>;
  semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
}>): EvidenceOsfSemanticCompletenessReceipt {
  return verifyEvidenceOsfSemanticCompleteness({
    receipt: input.receipt,
    source_text: input.sourceText,
    fact_frame: input.factFrame,
    semantic_formation: input.semanticFormation,
    sha256
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
