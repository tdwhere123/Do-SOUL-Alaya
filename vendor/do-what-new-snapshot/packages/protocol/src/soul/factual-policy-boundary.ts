import { z } from "zod";

export const FactualPolicyConditionSchema = z
  .object({
    affects_execution_paths: z.boolean(),
    affects_tool_choices: z.boolean(),
    affects_write_permissions: z.boolean(),
    affects_governance_decisions: z.boolean()
  })
  .readonly();

export type FactualPolicyCondition = z.infer<typeof FactualPolicyConditionSchema>;
