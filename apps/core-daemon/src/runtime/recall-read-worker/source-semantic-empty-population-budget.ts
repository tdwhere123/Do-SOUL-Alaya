import { sourceSemanticExecution, SourceSemanticResourceLedger, SourceSemanticResourceExhausted, SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
  type RequestBudget, type SourceRecordIdentity, type SourceSemanticAccessPolicy, type SourceSemanticQuery,
  type SourceSemanticResourceBudget, type SourceSemanticAccessReceipt, type SourceSemanticCompactPreparation,
  type SourceSemanticCompactAcquisition, type SourceSemanticHandleDescriptor,
  type SourceSemanticPreviewExtents, type PreparedSourceSemanticCanonicalSubtrees } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { preflightSemanticLeaseGroup, queryPreparationLease, semanticLeaseGroupAccountingCost,
  type QueryPreparationLeaseBase } from "./source-semantic-leases.js";
import { quoteAccessPoolIdentity, preparationAccessReceiptValue, sourceSemanticAccessReceiptValue,
  sourceSemanticObservationAccounting, type SourceSemanticIdentityCaptures } from "./source-semantic-access-receipts.js";

// This retained scalar exceeds a primitive by 88 bytes, also covering the size-only
// scan's bounded numeric encoding when an actual completion replaces it with a number.
const WIDE_SCALAR = "x".repeat(32);
const DIGEST = `sha256:${"0".repeat(64)}`;
const ALL_STOPS = ["budget", "source_limit", "interpretation_limit", "unavailable", "source_tail"] as const;

type Completion = Readonly<{
  runtime: SourceSemanticReadRuntime; parent: SourceSemanticReadBudget; child: SourceSemanticReadBudget;
  records: readonly SourceRecordIdentity[]; sourcePages: number;
  policy: SourceSemanticAccessPolicy; budget: RequestBudget; accessHint?: string;
  orderCost: (count: number) => SourceSemanticResourceBudget;
  leaseContext: QueryPreparationLeaseBase; suppliedQuerySemantics?: SourceSemanticQuery;
  phases?: Readonly<{ preparation: SourceSemanticCompactPreparation; acquisition: SourceSemanticCompactAcquisition }>;
  sourcePreviewExtents?: SourceSemanticPreviewExtents;
  leaseCount?: 1 | 2;
}> & SourceSemanticIdentityCaptures;
type CompletionPrice = SourceSemanticResourceBudget & { prepared?: PreparedSourceSemanticCanonicalSubtrees };

function add(...costs: readonly SourceSemanticResourceBudget[]): SourceSemanticResourceBudget {
  return { work_units: costs.reduce((sum, cost) => sum + cost.work_units, 0),
    memory_bytes: costs.reduce((sum, cost) => sum + cost.memory_bytes, 0) };
}

/** Both initial quotes and a conclusive census use the same actual receipt/lease constructors. */
function completionEnvelope(input: Completion, planning: SourceSemanticReadBudget,
  phase: "preparation_preflight" | "empty_census_completion") {
  const { records, policy, leaseContext } = input;
  planning.charge(1, 64, phase === "empty_census_completion"
    ? "empty interpretation completion planning" : "source union preparation completion planning");
  const sourceRows = records.map((record) => ({ source_id: record.source_id, record_id: record.identity,
    read_bytes: WIDE_SCALAR, body_bytes: WIDE_SCALAR, complete: WIDE_SCALAR,
    signal: { source_text_score: WIDE_SCALAR, interpretation_reading_score: WIDE_SCALAR } }));
  const beforeReceipt = { work_units: planning.spentWork, memory_bytes: planning.spentBytes };
  const value = sourceSemanticAccessReceiptValue(planning, policy, DIGEST, sourceRows, [],
    WIDE_SCALAR, WIDE_SCALAR, ALL_STOPS, input.sourcePreviewExtents, input.phases === undefined ? undefined : {
      ...input.phases, observation: null });
  const accounting = sourceSemanticObservationAccounting(value.phases[2], { spentWork: Number.MAX_SAFE_INTEGER,
    spentBytes: Number.MAX_SAFE_INTEGER, nativeBytes: Number.MAX_SAFE_INTEGER }, planning);
  // Acquisition can become known after the base quote. Always price the populated
  // observation tuple, even while its current phase would report unknown resources.
  const observation = accounting ?? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] as const;
  const receipt = { ...value, phases: [2, value.phases[1], value.phases[2], observation] as const };
  const construction = { work_units: planning.spentWork - beforeReceipt.work_units,
    memory_bytes: planning.spentBytes - beforeReceipt.memory_bytes };
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
  return { receipt, construction, pool, wideTrace, queryLease: sizedLease("query"), pageLease: sizedLease("page") };
}

/** Quote wider identity scalars through the preimage, canonical and hash owners.
 * Planning pays scans/frames, not the future scalar encoding or native hash handoff.
 */
function quoteIdentity(input: Completion, receipt: ReturnType<typeof completionEnvelope>["receipt"],
  planning: SourceSemanticReadBudget) {
  return quoteAccessPoolIdentity(input.runtime, input.leaseContext.workspace_id, input.leaseContext.authorized, receipt, planning, input);
}

/** Build the bounded completion quote with the actual retention and ordering owners. */
function planCompletion(input: Completion, planning: SourceSemanticReadBudget,
  phase: "preparation_preflight" | "empty_census_completion"): CompletionPrice {
  const { runtime, records, budget } = input;
  const { receipt, construction, pool, wideTrace, queryLease, pageLease } = completionEnvelope(input, planning, phase);
  const measure = (value: unknown) => SourceSemanticResourceLedger.quoteRetain(value, planning.remaining(), planning, "borrow");
  const overlay = (left: SourceSemanticResourceBudget, right: SourceSemanticResourceBudget) =>
    SourceSemanticResourceLedger.overlayRetainObjects(left, right, planning);
  // The owners above define the wire fields. Only numeric subtree prices survive this quote;
  // no repeated lease/trace walk reconstructs or rereads their shared receipt and pool.
  const emptyPrice = measure([]), receiptPrice = measure(receipt);
  const accessPrice = overlay(receiptPrice, measure({ pool_id: DIGEST }));
  const tracePrice = overlay(accessPrice, measure({ trace: wideTrace.trace }));
  const poolPrice = measure({ ...pool, sources: measure(records), descriptors: emptyPrice, access: accessPrice });
  const queryLeasePrice = measure({ ...queryLease, access_pool: poolPrice, candidates: emptyPrice });
  const leaseCount = input.leaseCount ?? (records.length > SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE ? 2 : 1);
  const beforeExecution = { work_units: planning.spentWork, memory_bytes: planning.spentBytes };
  sourceSemanticExecution(input.phases?.preparation, input.phases?.acquisition, planning);
  // Execution reuses owned compact phases; quote its actual framing/equality work, not a deep copy.
  const executionPrice = { work_units: planning.spentWork - beforeExecution.work_units,
    memory_bytes: planning.spentBytes - beforeExecution.memory_bytes };
  const pageLeasePrice = leaseCount === 2 ? measure({ ...pageLease, access_pool: poolPrice, candidates: emptyPrice }) : undefined;
  const beforeSizing = { work_units: planning.spentWork, memory_bytes: planning.spentBytes };
  preflightSemanticLeaseGroup(runtime, leaseCount === 2 ? [queryLease, pageLease] : [queryLease], planning);
  // Preflight executes the same size scan as publication. Its own spend stays spent;
  // a second allowance protects the future scan, including already-owned phase contents.
  const sizingPrice = { work_units: planning.spentWork - beforeSizing.work_units,
    memory_bytes: planning.spentBytes - beforeSizing.memory_bytes };
  const identity = phase === "empty_census_completion" ? quoteIdentity(input, receipt, planning) : undefined;
  try {
    const initial: CompletionPrice = add(construction, identity ?? { work_units: 0, memory_bytes: 0 }, emptyPrice,
      input.orderCost(records.length), receiptPrice, tracePrice, executionPrice,
      queryLeasePrice, ...(pageLeasePrice === undefined ? [] : [pageLeasePrice]), sizingPrice,
      { work_units: semanticLeaseGroupAccountingCost(leaseCount), memory_bytes: 0 });
    if (identity !== undefined) initial.prepared = identity.prepared;
    // A full retained pool must still be pageable under a fresh request's unchanged budget.
    if (leaseCount === 2) {
      const page = add(measure(input.suppliedQuerySemantics), poolPrice, tracePrice, measure(sourceSemanticExecution()),
        queryLeasePrice, pageLeasePrice!, sizingPrice,
        { work_units: semanticLeaseGroupAccountingCost(2), memory_bytes: 0 });
      if (page.work_units > budget.work_units || page.memory_bytes > budget.memory_bytes) {
        throw new SourceSemanticResourceExhausted("source-only continuation completion");
      }
    }
    return initial;
  } catch (error) { identity?.prepared.close(); throw error; }
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
  metadata(value: Readonly<{ preparation: SourceSemanticCompactPreparation }> | SourceSemanticCompactAcquisition): void {
    this.reserve(planning => {
      const payload = SourceSemanticResourceLedger.quoteRetain(value, planning.remaining(), planning, "borrow");
      // Retention borrows five references, but each future lease still scans the actual
      // phase for capacity. Immutable ownership does not exempt that separate operation.
      const retention = SourceSemanticResourceLedger.quoteRetain([payload, payload, payload, payload, payload], planning.remaining(), planning);
      const sizing = SourceSemanticResourceLedger.measureCanonicalJsonLength(value, planning.remaining(), planning);
      return add(retention, sizing, sizing);
    });
  }

  source(record: SourceRecordIdentity): void {
    if (this.sourceCount === SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) this.reservePageLease();
    const row = { source_id: record.source_id, record_id: record.identity,
      read_bytes: WIDE_SCALAR, body_bytes: WIDE_SCALAR, complete: WIDE_SCALAR,
      signal: { source_text_score: WIDE_SCALAR, interpretation_reading_score: WIDE_SCALAR } };
    // Lookup, order input/output references, receipt plus two retained query/page pool copies.
    this.reserve(planning => {
      const recordPrice = SourceSemanticResourceLedger.quoteRetain(record, planning.remaining(), planning);
      const rowPrice = SourceSemanticResourceLedger.quoteRetain(row, planning.remaining(), planning);
      const sizing = SourceSemanticResourceLedger.measureCanonicalJsonLength([record, row], planning.remaining(), planning);
      return add(SourceSemanticResourceLedger.quoteRetain([recordPrice, recordPrice, rowPrice, rowPrice, rowPrice, rowPrice],
        planning.remaining(), planning), sizing, sizing,
        this.increment(this.sourceCount), SourceSemanticReadBudget.tupleLookupCost("discovered", 1));
    });
    this.sourceCount++;
  }

  interpretation(descriptor: SourceSemanticHandleDescriptor, row: SourceSemanticAccessReceipt["interpretation_candidates"][number]): void {
    if (this.interpretationCount === SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) this.reservePageLease();
    this.reserve(planning => {
      const descriptorPrice = SourceSemanticResourceLedger.quoteRetain(descriptor, planning.remaining(), planning);
      const rowPrice = SourceSemanticResourceLedger.quoteRetain(row, planning.remaining(), planning);
      const sizing = SourceSemanticResourceLedger.measureCanonicalJsonLength([descriptor, row, descriptor.interpretation_id], planning.remaining(), planning);
      return add(SourceSemanticResourceLedger.quoteRetain([descriptorPrice, descriptorPrice, descriptorPrice,
        rowPrice, rowPrice, rowPrice, rowPrice, rowPrice], planning.remaining(), planning), sizing, sizing,
        this.increment(this.interpretationCount), SourceSemanticReadBudget.signalReconciliationCost(1));
    });
    this.interpretationCount++;
  }

  /** A conclusive census permits borrowing only after the retained union's complete
   * finalization is protected. Reuse its retention/lease-sizing holds, quote the
   * previously unreserved expanded identity, and recheck current lease capacity.
   */
  emptyCompletion(input: Completion): PreparedSourceSemanticCanonicalSubtrees | undefined {
    if (this.preparation === undefined || this.sourceCount !== input.records.length
      || this.sourceCount > SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE || this.interpretationCount !== 0) {
      this.release();
      return reserveEmptyInterpretationCompletion(input);
    }
    // No union members or descriptors can appear after this census. Base/member
    // holds already price widened receipt/trace/pool retention, and metadata holds
    // cover lease sizing of the captured phases; only identity/framing is added.
    const measured = this.reserve(planning => {
      const { receipt, construction, queryLease } = completionEnvelope(input, planning, "empty_census_completion");
      preflightSemanticLeaseGroup(input.runtime, [queryLease], planning);
      const identity = quoteIdentity(input, receipt, planning);
      const cost: CompletionPrice = add(construction, identity);
      cost.prepared = identity.prepared;
      return cost;
    });
    // Parent.remaining excludes every future hold and all executed planning. The
    // child's prior effects and deferred allowance are not another spendable pool.
    const outstanding = input.child.outstandingAllowance();
    input.child.work = input.parent.work - outstanding.work_units;
    input.child.bytes = input.parent.bytes - outstanding.memory_bytes;
    this.release();
    return measured.prepared;
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

  private reserve(quote: (planning: SourceSemanticReadBudget) => CompletionPrice): CompletionPrice {
    const outstanding = this.child.outstandingAllowance();
    this.parent.reserve(outstanding.work_units, outstanding.memory_bytes, "observation and held native allowance before completion quote");
    const planning = new SourceSemanticReadBudget({ work_units: this.parent.work - outstanding.work_units,
      memory_bytes: this.parent.bytes - outstanding.memory_bytes });
    let measured: CompletionPrice | undefined;
    try {
      try {
        measured = quote(planning);
        // Holds retain numeric obligations only, never the request's prepared plan.
        if (measured.prepared !== undefined) planning.charge(1, 128, "source identity completion numeric hold record");
        planning.reserve(measured.work_units, measured.memory_bytes, "incremental source union completion");
        const release = this.parent.hold(measured.prepared === undefined ? measured
          : { work_units: measured.work_units, memory_bytes: measured.memory_bytes });
        this.releases.push(release);
        return measured;
      } finally {
        this.parent.absorb(planning);
        // Never enlarge the existing observation child. Held completion stays outside its remainder.
        this.child.constrainToParent(this.parent);
      }
    } catch (error) { measured?.prepared?.close(); throw error; }
  }
}

/** Spend planner work on the same Protocol traversal used by actual retain calls. */
export function reserveEmptyInterpretationCompletion(input: Completion): PreparedSourceSemanticCanonicalSubtrees | undefined {
  const { parent, child } = input;
  // Already executed census/navigation/header spend has first claim on the request allowance.
  const outstanding = child.outstandingAllowance();
  parent.reserve(outstanding.work_units, outstanding.memory_bytes, "empty interpretation prior observation");
  const planning = new SourceSemanticReadBudget({ work_units: parent.work - outstanding.work_units,
    memory_bytes: parent.bytes - outstanding.memory_bytes });
  let initial: CompletionPrice | undefined;
  try {
    try {
      initial = planCompletion(input, planning, "empty_census_completion");
      planning.reserve(initial.work_units, initial.memory_bytes, "empty interpretation completion");
      // Only the parent's residual outside real future completion can be borrowed.
      child.work = planning.work - initial.work_units;
      child.bytes = planning.bytes - initial.memory_bytes;
      return initial.prepared;
    } finally {
      // Planning is real work; charge it even if a bound or lease preflight fails.
      parent.absorb(planning);
    }
  } catch (error) { initial?.prepared?.close(); throw error; }
}
