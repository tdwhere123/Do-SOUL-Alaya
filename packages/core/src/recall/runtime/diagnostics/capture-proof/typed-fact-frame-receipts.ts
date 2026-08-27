import { createHash } from "node:crypto";
import {
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  compareCodeUnits,
  verifyEvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCapture
} from "@do-soul/alaya-protocol";

export type TypedFactFrameReceiptInput = Readonly<{
  readonly capture: EvidenceFactFrameFormationCapture;
  readonly evidence_id: string;
}>;

export type TypedFactFrameCopyGap =
  | "typed_fact_frame_formation_unavailable"
  | "typed_fact_frame_formation_ineligible"
  | "typed_fact_frame_formation_rejected"
  | "typed_fact_frame_query_producer_denied"
  | "typed_fact_frame_producer_absent";

export type TypedFactFrameCopyResult = Readonly<{
  readonly receipts?: readonly TypedFactFrameReceiptInput[];
  readonly gap?: TypedFactFrameCopyGap;
}>;

export function copyTypedFactFrameReceiptsFromFormations(
  evidenceIds: readonly string[],
  formationsByEvidenceId: Readonly<Record<string, EvidenceFactFrameFormationCapture>> | undefined
): TypedFactFrameCopyResult {
  let sawDenied = false;
  let sawMissingProducer = false;
  const formationGaps = new Set<TypedFactFrameCopyGap>();
  const copied = uniqueSortedReceipts(evidenceIds.flatMap((evidenceId) => {
    const copiedOne = copyOne(evidenceId, formationsByEvidenceId?.[evidenceId]);
    if (copiedOne === "denied") sawDenied = true;
    if (copiedOne === "producer_absent") sawMissingProducer = true;
    if (copiedOne === "unavailable") {
      formationGaps.add("typed_fact_frame_formation_unavailable");
    }
    if (copiedOne === "ineligible") {
      formationGaps.add("typed_fact_frame_formation_ineligible");
    }
    if (copiedOne === "rejected") {
      formationGaps.add("typed_fact_frame_formation_rejected");
    }
    return typeof copiedOne === "string" ? [] : [copiedOne];
  }));
  if (copied.length > 0) return Object.freeze({ receipts: copied });
  if (sawDenied) {
    return Object.freeze({ gap: "typed_fact_frame_query_producer_denied" });
  }
  if (sawMissingProducer) {
    return Object.freeze({ gap: "typed_fact_frame_producer_absent" });
  }
  if (formationGaps.size === 1) {
    return Object.freeze({ gap: [...formationGaps][0] });
  }
  if (formationGaps.size > 1) {
    return Object.freeze({ gap: "typed_fact_frame_formation_unavailable" });
  }
  return Object.freeze({});
}

function copyOne(
  evidenceId: string,
  formation: EvidenceFactFrameFormationCapture | undefined
): TypedFactFrameReceiptInput | "absent" | "unavailable" | "ineligible" | "rejected"
  | "denied" | "producer_absent" {
  if (formation === undefined || evidenceId.length === 0) return "absent";
  // A digest mismatch is corrupted proof, not an ordinary unavailable gap.
  const verified = verifyEvidenceFactFrameFormationCapture(formation, sha256);
  if (verified.status === "ineligible") return "ineligible";
  if (verified.status === "rejected") return "rejected";
  if (verified.status !== "formed" || verified.fact_frame === null) return "unavailable";
  const producer = verified.producer_operator_id?.trim() ?? "";
  if (producer.length === 0) return "producer_absent";
  if (producer === RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID) return "denied";
  return Object.freeze({
    capture: verified,
    evidence_id: evidenceId
  });
}

function uniqueSortedReceipts(
  receipts: readonly TypedFactFrameReceiptInput[]
): readonly TypedFactFrameReceiptInput[] {
  const byKey = new Map<string, TypedFactFrameReceiptInput>();
  for (const receipt of receipts) {
    const key = receiptIdentity(receipt);
    if (!byKey.has(key)) byKey.set(key, receipt);
  }
  return Object.freeze([...byKey.values()].sort((left, right) =>
    compareCodeUnits(receiptIdentity(left), receiptIdentity(right))
  ));
}

function receiptIdentity(receipt: TypedFactFrameReceiptInput): string {
  return JSON.stringify([
    receipt.evidence_id,
    receipt.capture.capture_digest,
    receipt.capture.producer_operator_id ?? ""
  ]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
