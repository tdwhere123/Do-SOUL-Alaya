import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";
import type { EvidenceSearchProjection } from "./evidence-capsule.js";

export const ASSOCIATIVE_FACT_FRAME_SCHEMA_VERSION = 1 as const;
export const ASSOCIATIVE_FACT_FRAME_SLOT_LIMIT = 6;

export const AssociativeFactSlotRoleSchema = z.enum([
  "subject",
  "relation",
  "value",
  "qualifier",
  "time"
]);

export const AssociativeFactSlotSchema = z.object({
  role: AssociativeFactSlotRoleSchema,
  text: NonEmptyStringSchema.max(512)
}).strict().readonly();

export const AssociativeFactFrameSchema = z.object({
  schema_version: z.literal(ASSOCIATIVE_FACT_FRAME_SCHEMA_VERSION),
  slots: z.array(AssociativeFactSlotSchema)
    .min(3)
    .max(ASSOCIATIVE_FACT_FRAME_SLOT_LIMIT)
    .readonly()
}).strict().readonly();

export type AssociativeFactSlotRole = z.infer<typeof AssociativeFactSlotRoleSchema>;
export type AssociativeFactSlot = z.infer<typeof AssociativeFactSlotSchema>;
export type AssociativeFactFrame = z.infer<typeof AssociativeFactFrameSchema>;
export type AssociativeFactKeyProjectionForm = Readonly<
  | { readonly kind: "complete" }
  | {
    readonly kind: "leave_one_slot_out";
    readonly omitted_slot: Readonly<{
      readonly slot_index: number;
      readonly role: AssociativeFactSlotRole;
    }>;
  }
>;
export interface AttributedAssociativeFactKeyProjection {
  readonly projection: Readonly<EvidenceSearchProjection>;
  readonly forms: readonly Readonly<AssociativeFactKeyProjectionForm>[];
}

export const EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID =
  "evidence_fact_frame_formation_v1";
export const EvidenceFactFrameFormationStatusSchema = z.enum([
  "formed",
  "ineligible",
  "unavailable",
  "rejected"
]);
export const EvidenceFactFrameFormationProposalSchema = z.object({
  schema_version: z.literal(1),
  producer_operator_id: NonEmptyStringSchema.max(128),
  source_assertion: NonEmptyStringSchema,
  fact_frame: AssociativeFactFrameSchema
}).strict().readonly();
export const EvidenceFactFrameFormationCaptureSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID),
  status: EvidenceFactFrameFormationStatusSchema,
  producer_operator_id: NonEmptyStringSchema.max(128).nullable(),
  source_hash: NonEmptyStringSchema.nullable(),
  fact_frame: AssociativeFactFrameSchema.nullable(),
  capture_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u)
}).strict().superRefine((capture, context) => {
  const formed = capture.status === "formed";
  if (formed !== (capture.producer_operator_id !== null &&
      capture.source_hash !== null && capture.fact_frame !== null)) {
    context.addIssue({
      code: "custom",
      message: "formed fact-frame capture requires producer, source, and frame"
    });
  }
  if (!formed && capture.fact_frame !== null) {
    context.addIssue({
      code: "custom",
      message: "non-formed fact-frame capture cannot contain a frame"
    });
  }
}).readonly();

export type EvidenceFactFrameFormationStatus =
  z.infer<typeof EvidenceFactFrameFormationStatusSchema>;
export type EvidenceFactFrameFormationProposal =
  z.infer<typeof EvidenceFactFrameFormationProposalSchema>;
export type EvidenceFactFrameFormationCapture =
  z.infer<typeof EvidenceFactFrameFormationCaptureSchema>;
export type EvidenceFactFrameFormationCaptureBody = Omit<
  EvidenceFactFrameFormationCapture,
  "capture_digest"
>;

export function evidenceFactFrameFormationCapturePreimage(
  capture: Readonly<EvidenceFactFrameFormationCaptureBody>
): string {
  return JSON.stringify([
    capture.schema_version,
    capture.operator_id,
    capture.status,
    capture.producer_operator_id,
    capture.source_hash,
    capture.fact_frame === null
      ? null
      : [
          capture.fact_frame.schema_version,
          capture.fact_frame.slots.map((slot) => [slot.role, slot.text])
        ]
  ]);
}

export function verifyEvidenceFactFrameFormationCapture(
  value: unknown,
  sha256: (preimage: string) => string
): EvidenceFactFrameFormationCapture {
  const capture = EvidenceFactFrameFormationCaptureSchema.parse(value);
  const { capture_digest: _digest, ...body } = capture;
  const expected = `sha256:${sha256(
    evidenceFactFrameFormationCapturePreimage(body)
  )}`;
  if (capture.capture_digest !== expected) {
    throw new Error("evidence fact-frame formation capture digest mismatch");
  }
  return capture;
}

const REQUIRED_ROLES: readonly AssociativeFactSlotRole[] = [
  "subject",
  "relation",
  "value"
];

export function groundAssociativeFactFrame(
  proposal: unknown,
  sourceAssertion: string
): Readonly<AssociativeFactFrame> | null {
  const parsed = AssociativeFactFrameSchema.safeParse(proposal);
  if (!parsed.success || !hasRequiredRoles(parsed.data.slots)) return null;
  let cursor = 0;
  for (const slot of parsed.data.slots) {
    const index = sourceAssertion.indexOf(slot.text, cursor);
    if (index < 0) return null;
    cursor = index + slot.text.length;
  }
  return parsed.data;
}

export function buildAssociativeFactKeyProjections(
  frame: Readonly<AssociativeFactFrame>
): readonly Readonly<EvidenceSearchProjection>[] {
  return Object.freeze(buildAttributedAssociativeFactKeyProjections(frame).map(
    ({ projection }) => projection
  ));
}

export function buildAttributedAssociativeFactKeyProjections(
  frame: Readonly<AssociativeFactFrame>
): readonly Readonly<AttributedAssociativeFactKeyProjection>[] {
  const formsByContent = new Map<string, AssociativeFactKeyProjectionForm[]>();
  addProjectionForm(formsByContent, joinSlots(frame.slots), Object.freeze({
    kind: "complete"
  }));
  frame.slots.forEach((slot, omittedIndex) => addProjectionForm(
    formsByContent,
    joinSlots(frame.slots.filter((_, index) => index !== omittedIndex)),
    Object.freeze({
      kind: "leave_one_slot_out",
      omitted_slot: Object.freeze({ slot_index: omittedIndex, role: slot.role })
    })
  ));
  return Object.freeze([...formsByContent].map(([content, forms], index) =>
    Object.freeze({
      projection: Object.freeze({
        projection_id: index + 1,
        projection_kind: "fact_key" as const,
        content
      }),
      forms: Object.freeze(forms)
    })
  ));
}

function addProjectionForm(
  formsByContent: Map<string, AssociativeFactKeyProjectionForm[]>,
  content: string,
  form: AssociativeFactKeyProjectionForm
): void {
  if (content.length === 0) return;
  const forms = formsByContent.get(content) ?? [];
  forms.push(form);
  formsByContent.set(content, forms);
}

function hasRequiredRoles(slots: readonly Readonly<AssociativeFactSlot>[]): boolean {
  const roles = new Set(slots.map((slot) => slot.role));
  return REQUIRED_ROLES.every((role) => roles.has(role));
}

function joinSlots(slots: readonly Readonly<AssociativeFactSlot>[]): string {
  return slots.map((slot) => slot.text.trim()).filter(Boolean).join(" ");
}
