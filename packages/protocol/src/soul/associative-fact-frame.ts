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
