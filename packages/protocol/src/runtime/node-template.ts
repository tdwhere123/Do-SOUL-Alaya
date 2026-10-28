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

function literalSequence<const T extends readonly [string, ...string[]]>(values: T) {
  const items = values.map(value => z.literal(value)) as { -readonly [K in keyof T]: z.ZodLiteral<T[K]> };
  return z.tuple(items).readonly();
}

function frozenContractSchema<const T extends typeof frozenNodeTemplateContractValues[number]>(contract: T) {
  return z.object({
    node_template: z.literal<T["node_template"]>(contract.node_template),
    input: literalSequence<T["input"]>(contract.input),
    output: literalSequence<T["output"]>(contract.output),
    tools: literalSequence<T["tools"]>(contract.tools),
    approval: z.object({
      checkpoint_required: z.literal<T["approval"]["checkpoint_required"]>(contract.approval.checkpoint_required),
      user_confirmation_required: z.literal<T["approval"]["user_confirmation_required"]>(contract.approval.user_confirmation_required)
    }).strict().readonly(),
    budget: z.object({
      max_worker_delegations: z.literal<T["budget"]["max_worker_delegations"]>(contract.budget.max_worker_delegations),
      max_tool_calls: z.literal<T["budget"]["max_tool_calls"]>(contract.budget.max_tool_calls)
    }).strict().readonly()
  }).strict().readonly();
}

export const FrozenNodeTemplateContractsSchema = z.tuple([
  frozenContractSchema(frozenNodeTemplateContractValues[0]),
  frozenContractSchema(frozenNodeTemplateContractValues[1]),
  frozenContractSchema(frozenNodeTemplateContractValues[2]),
  frozenContractSchema(frozenNodeTemplateContractValues[3])
]).readonly();

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
 * @deprecated Use FROZEN_NODE_TEMPLATE_CONTRACTS. This alias is kept so
 * existing callers can migrate to the canonical constant name.
 */
export const FrozenNodeTemplateContracts = FROZEN_NODE_TEMPLATE_CONTRACTS;

export type NodeTemplateKind = z.infer<typeof NodeTemplateKindSchema>;
export type NodeTemplateContract = Readonly<z.infer<typeof NodeTemplateContractSchema>>;
export type FrozenNodeTemplateContracts = Readonly<z.infer<typeof FrozenNodeTemplateContractsSchema>>;
