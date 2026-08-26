import { createHash } from "node:crypto";
import type {
  AssociativeFactSlotRole,
  EvidenceFactFrameFormationCapture,
  OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import {
  EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
  EvidenceOsfSemanticCompletenessReceiptSchema,
  evidenceFactFrameGraphIsComplete,
  evidenceOsfSemanticCompletenessPreimage,
  verifyEvidenceOsfSemanticCompleteness,
  type EvidenceOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../semantic/open-semantic-factor-formation.js";

export { EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID } from
  "@do-soul/alaya-protocol";

type GroundedObligationSlot = Readonly<{
  readonly role: AssociativeFactSlotRole;
  readonly surface: string;
  readonly source_span: readonly [number, number];
  readonly position: number | null;
}>;

export type { EvidenceOsfSemanticCompletenessReceipt } from "@do-soul/alaya-protocol";

export function certifyEvidenceSemanticCompleteness(input: Readonly<{
  readonly sourceText: string;
  readonly factFrame: Readonly<EvidenceFactFrameFormationCapture>;
  readonly semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
}>): Readonly<{
  readonly semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
  readonly receipt: EvidenceOsfSemanticCompletenessReceipt;
}> {
  if (input.semanticFormation.status !== "formed") {
    return result(input.semanticFormation, receipt(input, "not_applicable",
      "upstream_not_formed", null));
  }
  if (input.factFrame.status !== "formed") {
    return rejected(input, "upstream_not_formed", null);
  }
  const obligation = buildObligation(input.sourceText, input.factFrame);
  if (obligation === null) {
    return rejected(input, "invalid_fact_frame_obligation", null);
  }
  if (input.semanticFormation.graph === null || !evidenceFactFrameGraphIsComplete({
    source_text: input.sourceText,
    fact_frame: input.factFrame.fact_frame,
    graph: input.semanticFormation.graph
  })) {
    return rejected(input, "semantic_graph_incomplete", obligation);
  }
  return result(input.semanticFormation, receipt(input, "certified", "complete", obligation));
}

type EvidenceObligation = Readonly<{
  readonly predicate: GroundedObligationSlot;
  readonly arguments: readonly GroundedObligationSlot[];
}>;

function rejected(
  input: Parameters<typeof certifyEvidenceSemanticCompleteness>[0],
  reason: "upstream_not_formed" | "invalid_fact_frame_obligation" |
    "semantic_graph_incomplete",
  obligation: EvidenceObligation | null
): ReturnType<typeof certifyEvidenceSemanticCompleteness> {
  const formation = materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: input.sourceText,
    negative_status: "rejected"
  });
  return result(formation, receipt(input, "rejected", reason, obligation));
}

function buildObligation(
  source: string,
  capture: Readonly<EvidenceFactFrameFormationCapture>
): EvidenceObligation | null {
  const slots = capture.fact_frame?.slots;
  if (slots === null || slots === undefined) return null;
  const grounded = groundSlots(source, slots);
  if (grounded === null) return null;
  const subject = onlyRole(grounded, "subject");
  const predicate = onlyRole(grounded, "relation");
  const value = onlyRole(grounded, "value");
  if (subject === null || predicate === null || value === null) return null;
  const constraints = grounded.filter(({ role }) => role === "qualifier" || role === "time");
  const argumentSlots = [subject, ...constraints, value].map((slot, position) =>
    Object.freeze({ ...slot, position }));
  return Object.freeze({
    predicate: Object.freeze({ ...predicate, position: null }),
    arguments: Object.freeze(argumentSlots)
  });
}

function groundSlots(
  source: string,
  slots: NonNullable<EvidenceFactFrameFormationCapture["fact_frame"]>["slots"]
): readonly GroundedObligationSlot[] | null {
  let cursor = 0;
  const grounded = slots.map((slot) => {
    const start = source.indexOf(slot.text, cursor);
    if (start < 0) return null;
    const end = start + slot.text.length;
    cursor = end;
    return Object.freeze({
      role: slot.role,
      surface: slot.text,
      source_span: Object.freeze([start, end]) as readonly [number, number],
      position: null
    });
  });
  return grounded.some((slot) => slot === null)
    ? null
    : Object.freeze(grounded as GroundedObligationSlot[]);
}

function onlyRole(
  slots: readonly GroundedObligationSlot[],
  role: "subject" | "relation" | "value"
): GroundedObligationSlot | null {
  const matches = slots.filter((slot) => slot.role === role);
  return matches.length === 1 ? matches[0]! : null;
}

function receipt(
  input: Parameters<typeof certifyEvidenceSemanticCompleteness>[0],
  status: EvidenceOsfSemanticCompletenessReceipt["status"],
  reason: EvidenceOsfSemanticCompletenessReceipt["reason_code"],
  obligation: EvidenceObligation | null
): EvidenceOsfSemanticCompletenessReceipt {
  const body = {
    schema_version: 1 as const,
    operator_id: EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
    status,
    reason_code: reason,
    fact_frame_capture_digest: input.factFrame.capture_digest,
    semantic_formation_capture_digest: input.semanticFormation.capture_digest,
    predicate: obligation?.predicate ?? null,
    arguments: obligation?.arguments ?? Object.freeze([]),
    arity: obligation?.arguments.length ?? null
  };
  return EvidenceOsfSemanticCompletenessReceiptSchema.parse(Object.freeze({
    ...body, receipt_digest: digest(evidenceOsfSemanticCompletenessPreimage(body))
  }));
}

function result(
  semanticFormation: OpenSemanticFactorFormationCapture,
  semanticCompleteness: EvidenceOsfSemanticCompletenessReceipt
): ReturnType<typeof certifyEvidenceSemanticCompleteness> {
  return Object.freeze({ semanticFormation, receipt: semanticCompleteness });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function verifyEvidenceSemanticCompletenessReceipt(input: Readonly<{
  readonly receipt: Readonly<EvidenceOsfSemanticCompletenessReceipt>;
  readonly sourceText: string;
  readonly factFrame: Readonly<EvidenceFactFrameFormationCapture>;
  readonly semanticFormation: Readonly<OpenSemanticFactorFormationCapture>;
}>): EvidenceOsfSemanticCompletenessReceipt {
  return verifyEvidenceOsfSemanticCompleteness({
    receipt: input.receipt,
    source_text: input.sourceText,
    fact_frame: input.factFrame,
    semantic_formation: input.semanticFormation,
    sha256: (preimage) => createHash("sha256").update(preimage, "utf8").digest("hex")
  });
}
