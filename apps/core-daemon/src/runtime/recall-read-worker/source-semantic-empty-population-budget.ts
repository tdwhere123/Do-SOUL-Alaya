import { sourceSemanticExecution, SourceSemanticResourceLedger, SourceSemanticResourceExhausted, SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
  type RequestBudget, type SourceRecordIdentity, type SourceSemanticAccessPolicy, type SourceSemanticQuery,
  type SourceSemanticResourceBudget, type SourceSemanticAccessReceipt, type SourceSemanticHandleDescriptor,
  type SourceSemanticPreviewExtents } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { preflightSemanticLeaseGroup, queryPreparationLease, semanticLeaseGroupAccountingCost,
  type QueryPreparationLeaseBase } from "./source-semantic-leases.js";
import { preparationAccessReceiptValue, sourceSemanticAccessReceiptValue } from "./source-semantic-access-receipts.js";

// The quoted encoding is wider than any finite binary64 JSON scalar; retain also charges it above a primitive.
const WIDE_SCALAR = "x".repeat(32);
const DIGEST = `sha256:${"0".repeat(64)}`;
const ALL_STOPS = ["budget", "source_limit", "interpretation_limit", "unavailable", "source_tail"] as const;

type Completion = Readonly<{
  runtime: SourceSemanticReadRuntime; parent: SourceSemanticReadBudget; child: SourceSemanticReadBudget;
  records: readonly SourceRecordIdentity[]; sourcePages: number;
  policy: SourceSemanticAccessPolicy; budget: RequestBudget; accessHint?: string;
  orderCost: (count: number) => SourceSemanticResourceBudget;
  leaseContext: QueryPreparationLeaseBase; suppliedQuerySemantics?: SourceSemanticQuery;
  phases?: Pick<SourceSemanticAccessReceipt, "preparation" | "acquisition">;
  sourcePreviewExtents?: SourceSemanticPreviewExtents;
  leaseCount?: 1 | 2;
}>;

function add(...costs: readonly SourceSemanticResourceBudget[]): SourceSemanticResourceBudget {
  return { work_units: costs.reduce((sum, cost) => sum + cost.work_units, 0),
    memory_bytes: costs.reduce((sum, cost) => sum + cost.memory_bytes, 0) };
}

/** The input is request-owned plain phase metadata; copy every occurrence, without identity-based sharing. */
function captureMetadata(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(captureMetadata));
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) captured[key] = captureMetadata((value as Record<string, unknown>)[key]);
  return Object.freeze(captured);
}

/** Build the bounded completion envelope with the actual receipt, retain, ordering and lease owners. */
function planCompletion(input: Completion, planning: SourceSemanticReadBudget,
  phase: "preparation_preflight" | "empty_census_completion"): SourceSemanticResourceBudget {
  const { runtime, records, policy, budget, leaseContext } = input;
  planning.charge(1, 64, phase === "empty_census_completion"
    ? "empty interpretation completion planning" : "source union preparation completion planning");
  const sourceRows = records.map((record) => ({ source_id: record.source_id, record_id: record.identity,
    read_bytes: WIDE_SCALAR, body_bytes: WIDE_SCALAR, complete: WIDE_SCALAR,
    signal: { source_text_score: WIDE_SCALAR, interpretation_reading_score: WIDE_SCALAR } }));
  const receipt = sourceSemanticAccessReceiptValue(policy, DIGEST, sourceRows, [],
    WIDE_SCALAR, WIDE_SCALAR, ALL_STOPS, input.sourcePreviewExtents, input.phases === undefined ? undefined : {
      ...input.phases, phase_accounting: {
        observation: { work: Number.MAX_SAFE_INTEGER, memory_bytes: Number.MAX_SAFE_INTEGER,
          native_bytes: Number.MAX_SAFE_INTEGER, sql_internal_work: "unknown" },
        completion: "included_in_worker_work_not_separately_measured", native_cpu: "unknown", deadline: "soft_quarantine_until_exit"
      } });
  const access = { ...receipt, pool_id: DIGEST };
  const pool = { sources: records, descriptors: [], access, sourcePages: WIDE_SCALAR, interpretationPages: WIDE_SCALAR,
    ...(input.sourcePreviewExtents === undefined ? {} : { sourcePreviewExtents: input.sourcePreviewExtents }),
    ...(input.accessHint === undefined ? {} : { accessHint: input.accessHint }) };
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
  const leaseCount = input.leaseCount ?? (records.length > SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE ? 2 : 1);
  const execution = sourceSemanticExecution(input.phases?.preparation, input.phases?.acquisition);
  const initial = add(measure([]), input.orderCost(records.length), measure(receipt), measure(wideTrace), measure(execution),
    measure(queryLease), ...(leaseCount === 2 ? [measure(pageLease)] : []),
    { work_units: semanticLeaseGroupAccountingCost(leaseCount), memory_bytes: 0 });

  // A full retained pool must still be pageable under a fresh request's unchanged budget.
  if (leaseCount === 2) {
    const page = add(measure(input.suppliedQuerySemantics), measure(pool), measure(wideTrace), measure(sourceSemanticExecution()),
      measure(queryLease), measure(pageLease),
      { work_units: semanticLeaseGroupAccountingCost(2), memory_bytes: 0 });
    if (page.work_units > budget.work_units || page.memory_bytes > budget.memory_bytes) {
      throw new SourceSemanticResourceExhausted("source-only continuation completion");
    }
  }
  preflightSemanticLeaseGroup(runtime, leaseCount === 2 ? [queryLease, pageLease] : [queryLease]);
  return initial;
}

/** Incremental completion quote for the shared union. The actual traversal and ordering owners
 * define the allowance; no root-count cap or invented work-to-memory conversion is used.
 * Parent holds stay distinct from child spend and are released before finalization executes.
 */
export class SourceSemanticUnionCompletion {
  private readonly releases: (() => void)[] = [];
  private sourceCount = 0;
  private interpretationCount = 0;
  private preparation?: Completion;
  private baseCost?: SourceSemanticResourceBudget;
  private pageLeaseReserved = false;
  constructor(private readonly parent: SourceSemanticReadBudget, private readonly child: SourceSemanticReadBudget,
    private readonly orderCost: (count: number) => SourceSemanticResourceBudget) {}

  /** Quote real lease/trace wrappers; page-wrapper growth is admitted only when the pool needs it. */
  preparationBase(input: Completion): void {
    this.preparation = input;
    this.reserve(planning => {
      const cost = planCompletion({ ...input, records: [], sourcePages: 0, leaseCount: 1 }, planning, "preparation_preflight");
      this.baseCost = cost; return cost;
    });
  }

  // Receipt, delivered trace, two query/page leases and current execution evidence.
  metadata(value: Pick<SourceSemanticAccessReceipt, "preparation"> | SourceSemanticAccessReceipt["acquisition"]): void {
    this.reserve(planning => {
      const beforeWork = planning.spentWork, beforeBytes = planning.spentBytes;
      // Bound the copy first. This guard is real traversal, distinct from capture and quotation.
      planning.retain(value, "source union metadata capture bound");
      const captureCost = { work_units: planning.spentWork - beforeWork, memory_bytes: planning.spentBytes - beforeBytes };
      planning.charge(captureCost.work_units, captureCost.memory_bytes, "source union immutable metadata capture");
      const captured = captureMetadata(value);
      const measure = (row: unknown) => SourceSemanticResourceLedger.measureRetain(row, planning.remaining(), planning);
      const payload = measure(captured);
      const slots = [undefined, undefined, undefined, undefined, undefined];
      const slot = measure(undefined), framedSlots = measure(slots);
      // The ledger owns both payload and framing prices. Sharing the capture eliminates planner
      // walks, not any of the five future retained/serialized occurrences reserved here.
      const quote = { work_units: slots.length * payload.work_units + framedSlots.work_units - slots.length * slot.work_units,
        memory_bytes: slots.length * payload.memory_bytes + framedSlots.memory_bytes - slots.length * slot.memory_bytes };
      planning.retain([captureCost, payload, slot, framedSlots, quote], "source union metadata quote bookkeeping");
      return quote;
    });
  }

  source(record: SourceRecordIdentity): void {
    if (this.sourceCount === SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) this.reservePageLease();
    const row = { source_id: record.source_id, record_id: record.identity,
      read_bytes: WIDE_SCALAR, body_bytes: WIDE_SCALAR, complete: WIDE_SCALAR,
      signal: { source_text_score: WIDE_SCALAR, interpretation_reading_score: WIDE_SCALAR } };
    // Lookup, order input/output references, receipt plus two retained query/page pool copies.
    this.hold([record, record, row, row, row, row], add(this.increment(this.sourceCount),
      SourceSemanticReadBudget.tupleLookupCost("discovered", 1)));
    this.sourceCount++;
  }

  interpretation(descriptor: SourceSemanticHandleDescriptor, row: SourceSemanticAccessReceipt["interpretation_candidates"][number]): void {
    if (this.interpretationCount === SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) this.reservePageLease();
    this.hold([descriptor, descriptor, descriptor, row, row, row, row, row], add(this.increment(this.interpretationCount),
      SourceSemanticReadBudget.signalReconciliationCost(1)));
    this.interpretationCount++;
  }

  release(): void { for (const release of this.releases.splice(0)) release(); }

  private reservePageLease(): void {
    if (this.pageLeaseReserved || this.preparation === undefined || this.baseCost === undefined) return;
    const input = this.preparation, previous = this.baseCost;
    this.reserve(planning => {
      const next = planCompletion({ ...input, records: [], sourcePages: 0, leaseCount: 2 }, planning, "preparation_preflight");
      return { work_units: Math.max(0, next.work_units - previous.work_units),
        memory_bytes: Math.max(0, next.memory_bytes - previous.memory_bytes) };
    });
    this.pageLeaseReserved = true;
  }

  private increment(count: number): SourceSemanticResourceBudget {
    const before = this.orderCost(count), after = this.orderCost(count + 1);
    return { work_units: after.work_units - before.work_units, memory_bytes: after.memory_bytes - before.memory_bytes };
  }

  private hold(value: unknown, extra: SourceSemanticResourceBudget = { work_units: 0, memory_bytes: 0 }): void {
    this.reserve(planning => add(SourceSemanticResourceLedger.measureRetain(value, planning.remaining(), planning), extra));
  }

  private reserve(quote: (planning: SourceSemanticReadBudget) => SourceSemanticResourceBudget): void {
    const outstanding = this.child.outstandingAllowance();
    this.parent.reserve(outstanding.work_units, outstanding.memory_bytes, "observation and held native allowance before completion quote");
    const planning = new SourceSemanticReadBudget({ work_units: this.parent.work - outstanding.work_units,
      memory_bytes: this.parent.bytes - outstanding.memory_bytes });
    try {
      const measured = quote(planning);
      planning.reserve(measured.work_units, measured.memory_bytes, "incremental source union completion");
      const release = this.parent.hold(measured);
      this.releases.push(release);
    } finally {
      this.parent.absorb(planning);
      // Never enlarge the existing observation child. Held completion must remain outside its spendable remainder.
      this.child.constrainToParent(this.parent);
    }
  }
}

/** Spend planner work on the same Protocol traversal used by actual retain calls. */
export function reserveEmptyInterpretationCompletion(input: Completion): void {
  const { parent, child } = input;
  // Already executed census/navigation/header spend has first claim on the request allowance.
  parent.reserve(child.spentWork, child.spentBytes, "empty interpretation prior observation");
  const planning = new SourceSemanticReadBudget({ work_units: parent.work - child.spentWork,
    memory_bytes: parent.bytes - child.spentBytes });
  try {
    const initial = planCompletion(input, planning, "empty_census_completion");
    planning.reserve(initial.work_units, initial.memory_bytes, "empty interpretation completion");
    child.work = planning.work - initial.work_units;
    child.bytes = planning.bytes - initial.memory_bytes;
  } finally {
    // Planning is real work; charge it even if a bound or lease preflight fails.
    parent.absorb(planning);
  }
}
