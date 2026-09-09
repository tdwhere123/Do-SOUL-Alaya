import type { RequestBudget } from "@do-soul/alaya-protocol";
import type { OrdinaryLanguageCompileInput } from "../conditional-field/query/compile-query.js";

export interface ConditionalFieldExecutionReceipt {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly requested_budget: RequestBudget;
  readonly compile_input: Omit<OrdinaryLanguageCompileInput, "memory" | "relations" | "query_id">;
  readonly query_id: string;
  readonly interpretation_id: string;
  readonly snapshot_id: string;
  readonly interpretation_clock: string;
}
