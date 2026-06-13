import { z } from "zod";
import { deepFreeze } from "../shared/deep-freeze.js";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { ToolCategorySchema } from "../tools/tool-spec.js";

export const NodeTemplateKindSchema = z.enum(["analyze", "plan", "build", "review"]);

export const NodeTemplateContractSchema = z
  .object({
    node_template: NodeTemplateKindSchema,
    input: z.array(NonEmptyStringSchema).readonly(),
    output: z.array(NonEmptyStringSchema).readonly(),
    tools: z.array(ToolCategorySchema).readonly(),
    approval: z
      .object({
        checkpoint_required: z.boolean(),
        user_confirmation_required: z.boolean()
      })
      .strict()
      .readonly(),
    budget: z
      .object({
        max_worker_delegations: NonNegativeIntSchema,
        max_tool_calls: NonNegativeIntSchema
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

const AnalyzeNodeTemplateContractSchema = z
  .object({
    node_template: z.literal("analyze"),
    input: z.tuple([z.literal("prompt"), z.literal("evidence")]).readonly(),
    output: z.tuple([z.literal("analysis_note")]).readonly(),
    tools: z.tuple([z.literal("read"), z.literal("validation"), z.literal("evidence")]).readonly(),
    approval: z
      .object({
        checkpoint_required: z.literal(false),
        user_confirmation_required: z.literal(false)
      })
      .strict()
      .readonly(),
    budget: z
      .object({
        max_worker_delegations: z.literal(0),
        max_tool_calls: z.literal(3)
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

const PlanNodeTemplateContractSchema = z
  .object({
    node_template: z.literal("plan"),
    input: z.tuple([z.literal("goal")]).readonly(),
    output: z.tuple([z.literal("plan")]).readonly(),
    tools: z.tuple([z.literal("read"), z.literal("validation"), z.literal("governance")]).readonly(),
    approval: z
      .object({
        checkpoint_required: z.literal(true),
        user_confirmation_required: z.literal(false)
      })
      .strict()
      .readonly(),
    budget: z
      .object({
        max_worker_delegations: z.literal(1),
        max_tool_calls: z.literal(4)
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

const BuildNodeTemplateContractSchema = z
  .object({
    node_template: z.literal("build"),
    input: z.tuple([z.literal("spec")]).readonly(),
    output: z.tuple([z.literal("patch")]).readonly(),
    tools: z.tuple([z.literal("read"), z.literal("write"), z.literal("exec"), z.literal("validation")]).readonly(),
    approval: z
      .object({
        checkpoint_required: z.literal(true),
        user_confirmation_required: z.literal(true)
      })
      .strict()
      .readonly(),
    budget: z
      .object({
        max_worker_delegations: z.literal(2),
        max_tool_calls: z.literal(8)
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

const ReviewNodeTemplateContractSchema = z
  .object({
    node_template: z.literal("review"),
    input: z.tuple([z.literal("diff")]).readonly(),
    output: z.tuple([z.literal("review_summary")]).readonly(),
    tools: z.tuple([z.literal("read"), z.literal("validation"), z.literal("evidence")]).readonly(),
    approval: z
      .object({
        checkpoint_required: z.literal(false),
        user_confirmation_required: z.literal(true)
      })
      .strict()
      .readonly(),
    budget: z
      .object({
        max_worker_delegations: z.literal(0),
        max_tool_calls: z.literal(2)
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

export const FrozenNodeTemplateContractsSchema = z
  .tuple([
    AnalyzeNodeTemplateContractSchema,
    PlanNodeTemplateContractSchema,
    BuildNodeTemplateContractSchema,
    ReviewNodeTemplateContractSchema
  ])
  .readonly();

const frozenNodeTemplateContractValues = [
  {
    node_template: "analyze",
    input: ["prompt", "evidence"],
    output: ["analysis_note"],
    tools: ["read", "validation", "evidence"],
    approval: {
      checkpoint_required: false,
      user_confirmation_required: false
    },
    budget: {
      max_worker_delegations: 0,
      max_tool_calls: 3
    }
  },
  {
    node_template: "plan",
    input: ["goal"],
    output: ["plan"],
    tools: ["read", "validation", "governance"],
    approval: {
      checkpoint_required: true,
      user_confirmation_required: false
    },
    budget: {
      max_worker_delegations: 1,
      max_tool_calls: 4
    }
  },
  {
    node_template: "build",
    input: ["spec"],
    output: ["patch"],
    tools: ["read", "write", "exec", "validation"],
    approval: {
      checkpoint_required: true,
      user_confirmation_required: true
    },
    budget: {
      max_worker_delegations: 2,
      max_tool_calls: 8
    }
  },
  {
    node_template: "review",
    input: ["diff"],
    output: ["review_summary"],
    tools: ["read", "validation", "evidence"],
    approval: {
      checkpoint_required: false,
      user_confirmation_required: true
    },
    budget: {
      max_worker_delegations: 0,
      max_tool_calls: 2
    }
  }
] as const;

export function assertFrozenNodeTemplateContracts(
  value: unknown = FROZEN_NODE_TEMPLATE_CONTRACTS
): asserts value is FrozenNodeTemplateContracts {
  const parsed = FrozenNodeTemplateContractsSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(
      `Invalid frozen node template contracts. Check packages/protocol/src/runtime/node-template.ts before startup. ${parsed.error.message}`
    );
  }
}

export const FROZEN_NODE_TEMPLATE_CONTRACTS = deepFreeze(
  frozenNodeTemplateContractValues
) as FrozenNodeTemplateContracts;

/**
 * @deprecated Use FROZEN_NODE_TEMPLATE_CONTRACTS. This alias is kept for A1-1
 * compatibility while callers migrate to the canonical constant name.
 */
export const FrozenNodeTemplateContracts = FROZEN_NODE_TEMPLATE_CONTRACTS;

export type NodeTemplateKind = z.infer<typeof NodeTemplateKindSchema>;
export type NodeTemplateContract = Readonly<z.infer<typeof NodeTemplateContractSchema>>;
export type FrozenNodeTemplateContracts = Readonly<z.infer<typeof FrozenNodeTemplateContractsSchema>>;
