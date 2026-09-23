import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted, SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
  type RequestBudget, type SourceRecordIdentity, type SourceSemanticAccessPolicy, type SourceSemanticQuery,
  type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { preflightSemanticLeaseGroup, queryPreparationLease, semanticLeaseGroupAccountingCost,
  type QueryPreparationLeaseBase } from "./source-semantic-leases.js";
import { preparationAccessReceiptValue, sourceSemanticAccessReceiptValue } from "./source-semantic-access-receipts.js";

// The quoted encoding is wider than any finite binary64 JSON scalar; retain also charges it above a primitive.
const WIDE_SCALAR = "x".repeat(32);
const DIGEST = `sha256:${"0".repeat(64)}`;
const ALL_STOPS = ["budget", "source_limit", "interpretation_limit", "unavailable", "source_tail"] as const;

type Completion = Readonly<{
  runtime: RecallReadWorkerRuntime; parent: SourceSemanticReadBudget; child: SourceSemanticReadBudget;
  records: readonly SourceRecordIdentity[]; sourcePages: number;
  policy: SourceSemanticAccessPolicy; budget: RequestBudget;
  orderCost: (count: number) => SourceSemanticResourceBudget;
  leaseContext: QueryPreparationLeaseBase; suppliedQuerySemantics?: SourceSemanticQuery;
}>;

function add(...costs: readonly SourceSemanticResourceBudget[]): SourceSemanticResourceBudget {
  return { work_units: costs.reduce((sum, cost) => sum + cost.work_units, 0),
    memory_bytes: costs.reduce((sum, cost) => sum + cost.memory_bytes, 0) };
}

/** Build the bounded completion envelope with the actual receipt, retain, ordering and lease owners. */
function planCompletion(input: Completion, planning: SourceSemanticReadBudget): SourceSemanticResourceBudget {
  const { runtime, records, sourcePages, policy, budget, leaseContext } = input;
  planning.charge(1, 64, "empty interpretation completion planning");
  const sourceRows = records.map((record) => ({ source_id: record.source_id, record_id: record.identity,
    read_bytes: WIDE_SCALAR, body_bytes: WIDE_SCALAR, complete: WIDE_SCALAR,
    signal: { source_text_score: WIDE_SCALAR, interpretation_reading_score: WIDE_SCALAR } }));
  const receipt = sourceSemanticAccessReceiptValue(policy, DIGEST, sourceRows, [],
    WIDE_SCALAR, WIDE_SCALAR, ALL_STOPS);
  const access = { ...receipt, pool_id: DIGEST };
  const pool = { sources: records, descriptors: [], access, sourcePages, interpretationPages: 1 };
  const trace = preparationAccessReceiptValue(pool, 0, 0, 0, records.length);
  // Widen numeric trace scalars; the field set comes from the delivery owner above.
  const wideTrace = { ...trace, trace: Object.fromEntries(Object.entries(trace.trace!).map(([key, value]) =>
    [key, typeof value === "number" ? WIDE_SCALAR : value])) };
  const sizedLease = (kind: "query" | "page") => ({
    ...queryPreparationLease(leaseContext, pool, 0, 0, false), kind,
    truncated: WIDE_SCALAR, access_offset: WIDE_SCALAR, access_source_offset: WIDE_SCALAR
  });
  const queryLease = sizedLease("query"), pageLease = sizedLease("page");
  const measure = (value: unknown) => SourceSemanticResourceLedger.measureRetain(value, planning.remaining(), planning);
  const leaseCount = records.length > SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE ? 2 : 1;
  const initial = add(measure([]), input.orderCost(records.length), measure(receipt), measure(wideTrace),
    measure(queryLease), ...(leaseCount === 2 ? [measure(pageLease)] : []),
    { work_units: semanticLeaseGroupAccountingCost(leaseCount), memory_bytes: 0 });

  // A full retained pool must still be pageable under a fresh request's unchanged budget.
  if (leaseCount === 2) {
    const page = add(measure(input.suppliedQuerySemantics), measure(pool), measure(wideTrace),
      measure(queryLease), measure(pageLease),
      { work_units: semanticLeaseGroupAccountingCost(2), memory_bytes: 0 });
    if (page.work_units > budget.work_units || page.memory_bytes > budget.memory_bytes) {
      throw new SourceSemanticResourceExhausted("source-only continuation completion");
    }
  }
  preflightSemanticLeaseGroup(runtime, leaseCount === 2 ? [queryLease, pageLease] : [queryLease]);
  return initial;
}

/** Spend planner work on the same Protocol traversal used by actual retain calls. */
export function reserveEmptyInterpretationCompletion(input: Completion): void {
  const { parent, child } = input;
  // Already executed census/navigation/header spend has first claim on the request allowance.
  parent.reserve(child.spentWork, child.spentBytes, "empty interpretation prior observation");
  const planning = new SourceSemanticReadBudget({ work_units: parent.work - child.spentWork,
    memory_bytes: parent.bytes - child.spentBytes });
  try {
    const initial = planCompletion(input, planning);
    planning.reserve(initial.work_units, initial.memory_bytes, "empty interpretation completion");
    child.work = planning.work - initial.work_units;
    child.bytes = planning.bytes - initial.memory_bytes;
  } finally {
    // Planning is real work; charge it even if a bound or lease preflight fails.
    parent.absorb(planning);
  }
}
