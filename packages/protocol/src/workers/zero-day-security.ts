import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { ToolCategorySchema } from "../tools/tool-spec.js";

export const ZeroDayPolicyKindSchema = z.enum(["deny_category", "deny_tool", "hard_stop"]);

const ZeroDayPolicyBaseSchema = z.object({
  policy_id: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
  effective_at: IsoDatetimeStringSchema,
  expires_at: IsoDatetimeStringSchema.nullable()
});

export const ZeroDayPolicySchema = z
  .discriminatedUnion("kind", [
    ZeroDayPolicyBaseSchema.extend({
      kind: z.literal("deny_category"),
      target: ToolCategorySchema
    }).strict(),
    ZeroDayPolicyBaseSchema.extend({
      kind: z.literal("deny_tool"),
      target: NonEmptyStringSchema
    }).strict(),
    ZeroDayPolicyBaseSchema.extend({
      kind: z.literal("hard_stop"),
      target: NonEmptyStringSchema
    }).strict()
  ])
  .superRefine((policy, ctx) => {
    if (policy.expires_at !== null && Date.parse(policy.expires_at) <= Date.parse(policy.effective_at)) {
      ctx.addIssue({
        code: "custom",
        message: "Zero-day policy expiry must be later than effective_at",
        path: ["expires_at"]
      });
    }
  })
  .readonly();

export type ZeroDayPolicyKind = z.infer<typeof ZeroDayPolicyKindSchema>;
export type ZeroDayPolicy = z.infer<typeof ZeroDayPolicySchema>;
