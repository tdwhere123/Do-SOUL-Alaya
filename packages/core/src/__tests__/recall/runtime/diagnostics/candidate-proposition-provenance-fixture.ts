import { createHash } from "node:crypto";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  evidenceFactFrameFormationCapturePreimage,
  type AssociativeFactSlotRole,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCaptureBody
} from "@do-soul/alaya-protocol";
import {
  collateCandidatePropositionProvenance,
  type CandidatePropositionProvenance,
  type CandidatePropositionProvenanceInput,
  type TypedFactFrameReceiptInput
} from "../../../../recall/runtime/diagnostics/candidate-proposition-provenance.js";

export const GOLD = "cand-gold";
export const DISTRACTOR = "cand-distractor";
export const FORBIDDEN_RANKING_KEYS = [
  "fused_score",
  "fused_rank",
  "quality",
  "reserve",
  "reserved_by",
  "Values_v",
  "unscaled_remainder"
] as const;

const SOURCE_HASH = `sha256:${"a".repeat(64)}`;

export function collate(
  input: CandidatePropositionProvenanceInput
): Readonly<Record<string, CandidatePropositionProvenance>> {
  return collateCandidatePropositionProvenance(input);
}

export function gapInput(): CandidatePropositionProvenanceInput {
  return {
    candidate_keys: [GOLD, DISTRACTOR],
    open_semantic_factor_composition: {
      status: "unavailable",
      truncated: false,
      bindings: []
    },
    candidates: [candidate(GOLD), candidate(DISTRACTOR)]
  };
}

export function candidate(
  candidateKey: string,
  rest: Omit<NonNullable<CandidatePropositionProvenanceInput["candidates"]>[number],
    "candidate_key"> = {}
): NonNullable<CandidatePropositionProvenanceInput["candidates"]>[number] {
  return { candidate_key: candidateKey, ...rest };
}

export function frame(
  producerOperatorId: string | null,
  slots: readonly (readonly [AssociativeFactSlotRole, string])[],
  evidenceId = "ev-1"
): TypedFactFrameReceiptInput {
  const mapped = slots.map(([role, text]) => ({ role, text }));
  const producer = producerOperatorId?.trim() ?? "";
  const capture = producer.length > 0 && mapped.length >= 3
    ? digestCapture({
        schema_version: 1,
        operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
        status: "formed",
        producer_operator_id: producer,
        source_hash: SOURCE_HASH,
        fact_frame: { schema_version: 1, slots: mapped }
      })
    : {
        schema_version: 1,
        operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
        status: "formed",
        producer_operator_id: producerOperatorId,
        source_hash: SOURCE_HASH,
        fact_frame: { schema_version: 1, slots: mapped },
        capture_digest: `sha256:${"0".repeat(64)}`
      } as EvidenceFactFrameFormationCapture;
  return { capture, evidence_id: evidenceId };
}

export function copiedSlots(
  row: CandidatePropositionProvenance
): readonly { readonly role: string; readonly text: string }[] {
  if (row.typed_fact_frames.status !== "available") return [];
  return row.typed_fact_frames.value.flatMap((item) => item.capture.fact_frame?.slots ?? []);
}

export function hasJoinedProposition(
  row: CandidatePropositionProvenance,
  subject: string,
  relation: string,
  value: string
): boolean {
  const payload = JSON.stringify(row);
  if (payload.includes(`proposition_id`) &&
      payload.includes(subject) && payload.includes(value)) {
    return true;
  }
  if (row.typed_fact_frames.status !== "available") return false;
  return row.typed_fact_frames.value.some((item) => {
    const byRole = new Map(
      (item.capture.fact_frame?.slots ?? []).map((slot) => [slot.role, slot.text])
    );
    return byRole.get("subject") === subject &&
      byRole.get("relation") === relation &&
      byRole.get("value") === value;
  });
}

export function collectKeys(value: unknown, seen = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") return seen;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, seen);
    return seen;
  }
  for (const [key, child] of Object.entries(value)) {
    seen.add(key);
    collectKeys(child, seen);
  }
  return seen;
}

function digestCapture(
  body: Readonly<EvidenceFactFrameFormationCaptureBody>
): EvidenceFactFrameFormationCapture {
  return {
    ...body,
    capture_digest: `sha256:${createHash("sha256")
      .update(evidenceFactFrameFormationCapturePreimage(body), "utf8")
      .digest("hex")}`
  };
}
