import { z } from "zod";

export const RecallFactKeyProjectionFormSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }).strict().readonly(),
  z.object({
    kind: z.literal("leave_one_slot_out"),
    omitted_slot: z.object({
      slot_index: z.number().int().nonnegative(),
      role: z.enum(["subject", "relation", "value", "qualifier", "time"])
    }).strict().readonly()
  }).strict().readonly()
]);

export const RecallFactSlotSchema = z.object({
  role: z.enum(["subject", "relation", "value", "qualifier", "time"]),
  text: z.string().min(1).max(512)
}).strict().readonly();

export function factSlotsHaveRequiredRoles(
  slots: readonly z.infer<typeof RecallFactSlotSchema>[]
): boolean {
  const roles = new Set(slots.map(({ role }) => role));
  return REQUIRED_ROLES.every((role) => roles.has(role));
}

const REQUIRED_ROLES: readonly z.infer<typeof RecallFactSlotSchema>["role"][] = [
  "subject",
  "relation",
  "value"
];
