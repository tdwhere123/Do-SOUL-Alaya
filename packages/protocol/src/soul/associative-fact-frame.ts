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
  const contents = [
    joinSlots(frame.slots),
    ...frame.slots.map((_, omittedIndex) =>
      joinSlots(frame.slots.filter((__, index) => index !== omittedIndex))
    )
  ];
  const uniqueContents = [...new Set(contents.filter((content) => content.length > 0))];
  return Object.freeze(uniqueContents.map((content, index) => Object.freeze({
    projection_id: index + 1,
    projection_kind: "fact_key" as const,
    content
  })));
}

function hasRequiredRoles(slots: readonly Readonly<AssociativeFactSlot>[]): boolean {
  const roles = new Set(slots.map((slot) => slot.role));
  return REQUIRED_ROLES.every((role) => roles.has(role));
}

function joinSlots(slots: readonly Readonly<AssociativeFactSlot>[]): string {
  return slots.map((slot) => slot.text.trim()).filter(Boolean).join(" ");
}
