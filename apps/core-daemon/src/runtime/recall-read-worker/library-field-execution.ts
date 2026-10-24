import { SNAPSHOT_PIN_NATIVE_WORK, type RequestBudget, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { CoreError, type ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { workOf } from "./source-semantic-discovery.js";
import { settleWorkerDelivery } from "./prepared-delivery.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type Page = ConditionalFieldRecallPortResult;

/** The shared producer pays its own phases. Transfer that measured expenditure
 * into the enclosing library allowance once, before publishing a library lease.
 * Failed post-processing discards the prepared page through its settlement owner. */
export function executeLibraryField(runtime: RecallReadWorkerRuntime, meter: SourceSemanticReadBudget,
  budget: RequestBudget, indexWork: () => number, run: (capture: (work: number | undefined) => void) => Page,
  deliver: (page: Page) => SourceSemanticWorkerResult): SourceSemanticWorkerResult {
  const release = meter.hold({ work_units: Math.min(budget.finalization_reserve, meter.work), memory_bytes: 0 });
  const field = meter.child(meter.remaining(), "field");
  let page: Page | undefined, transferred = false, budgetWork: number | undefined;
  try {
    page = run(work => { budgetWork = work; });
    release();
    const actual = page.execution_receipt?.actual;
    if (actual === undefined || budgetWork === undefined) {
      throw new CoreError("OBLIGATION_VIOLATION", "live field execution lacks measured budget work");
    }
    field.charge(budgetWork + SNAPSHOT_PIN_NATIVE_WORK, actual.charged_retained_bytes, "shared field execution");
    field.nativeWork = actual.native_visits + SNAPSHOT_PIN_NATIVE_WORK;
    field.nativeBytes = actual.native_bytes;
    field.indexWork = indexWork();
    meter.absorb(field); transferred = true;
    meter.observer?.event("field_execution_cost", "field", () => ({ actual, budget_work: budgetWork,
      index_work: field.indexWork, snapshot_pin_work: SNAPSHOT_PIN_NATIVE_WORK }));
    // Core has not executed its acknowledgment pin yet. Final library packing
    // must not spend that reserved allowance; the later settlement receipt owns
    // its actual debit, rather than billing unexecuted work as preparation.
    const releaseIssue = meter.hold({ work_units: SNAPSHOT_PIN_NATIVE_WORK, memory_bytes: 0 });
    try { return deliver(page); }
    finally { releaseIssue(); }
  } catch (error) {
    release();
    if (page?.preparation_id !== undefined) settleWorkerDelivery(runtime, { preparation_id: page.preparation_id }, true);
    attachIncurredLibraryWork(error, meter, page, transferred);
    throw error;
  } finally { release(); }
}

/** Preserve separate field evidence if its expenditure could not be transferred.
 * A partial subtotal must never claim complete native accounting. */
function attachIncurredLibraryWork(error: unknown, meter: SourceSemanticReadBudget, page: Page | undefined,
  transferred: boolean): void {
  if (!(error instanceof Error)) return;
  const target = error as Error & { details?: Readonly<Record<string, unknown>> };
  const details = target.details ?? {};
  try {
    target.details = Object.freeze({ ...details,
      ...(Object.hasOwn(details, "work") ? {} : { work: Object.freeze({ ...workOf(meter),
        ...(!transferred ? { native_accounting: "partial" as const } : {}) }) }),
      ...(page?.execution_receipt === undefined ? {} : { execution_receipt: page.execution_receipt }) });
  } catch {
    // Immutable failures retain their original classification and owner evidence.
  }
}
