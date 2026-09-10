import type { RequestBudget } from "@do-soul/alaya-protocol";
import type { OrdinaryLanguageCompileInput } from "../conditional-field/query/compile-query.js";
import type { RequestActualCost } from "./request-cost-ledger.js";

export type {
  RequestActualCost,
  RequestCostPhase,
  RequestPhaseCost
} from "./request-cost-ledger.js";

export interface ConditionalFieldExecutionReceipt {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly requested_budget: RequestBudget;
  readonly compile_input: Omit<OrdinaryLanguageCompileInput, "memory" | "relations" | "query_id">;
  readonly query_id: string;
  readonly interpretation_id: string;
  readonly snapshot_id: string;
  readonly interpretation_clock: string;
  readonly actual?: RequestActualCost;
}
