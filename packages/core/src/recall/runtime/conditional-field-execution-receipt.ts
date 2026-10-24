import type { RequestBudget } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
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
  readonly query_preparation?: import("@do-soul/alaya-protocol").SourceSemanticQueryPreparation;
}

/** Preserve the incurred request receipt through the existing refusal boundary.
 * Daemon/library measured work keeps its own authority (`details.worker`,
 * `details.work`); this only adds Core's request ledger and never replaces,
 * reinterprets or sums an existing snapshot.
 */
export function attachIncurredExecutionReceipt(
  error: unknown, receipt: ConditionalFieldExecutionReceipt
): unknown {
  if (!(error instanceof CoreError) || error.details?.execution_receipt !== undefined) return error;
  return new CoreError(error.code, error.message, {
    ...(error.subCode === undefined ? {} : { subCode: error.subCode }),
    details: { ...(error.details ?? {}), execution_receipt: receipt },
    cause: error
  });
}
