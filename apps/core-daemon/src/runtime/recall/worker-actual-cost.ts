import { performance } from "node:perf_hooks";
import { SNAPSHOT_PIN_NATIVE_WORK } from "@do-soul/alaya-protocol";
import {
  CoreError,
  type ConditionalFieldExecutionReceipt,
  type runConditionalFieldRecallWithReceipt,
  type ObserverReaders
} from "@do-soul/alaya-core";

/** Live process RSS; not a budget copy or guessed envelope constant. */
export const RSS_SAMPLING_METHOD = "process.memoryUsage().rss" as const;

export type WorkerActualCost = Readonly<{
  readonly native_visits: number;
  readonly bytes_read: number;
  readonly row_visits: number;
  readonly elapsed_ms: number;
  readonly rss_bytes: number;
  readonly rss_sampling_method: typeof RSS_SAMPLING_METHOD;
}>;

type WorkerFailureCost = Omit<WorkerActualCost, "native_visits" | "bytes_read" | "row_visits"> & Readonly<{
  readonly native_visits: number | null;
  readonly bytes_read: number | null;
  readonly row_visits: number | null;
}>;

/** Worker pages sit beside core `actual`; overlaying them collides with `actual.native_visits`. */
export type WorkerExecutionReceipt = ConditionalFieldExecutionReceipt & {
  readonly worker: WorkerActualCost;
};

type NativeCostCounters = {
  native_visits: number | null;
  bytes_read: number | null;
  row_visits: number | null;
};

type NativePage = Readonly<{
  readonly nativeVisits?: number;
  readonly nativeWork?: number;
  readonly rowsRead?: number;
  readonly rowVisits?: number;
  readonly bytesRead?: number;
  readonly metadataBytes?: number;
  readonly metadataUtf8Bytes?: number;
}>;

export function withWorkerActualCost<T extends {
  readonly execution_receipt: ConditionalFieldExecutionReceipt;
  readonly issue?: ReturnType<typeof runConditionalFieldRecallWithReceipt>["issue"];
}>(
  readers: ObserverReaders,
  run: (readers: ObserverReaders) => T
): Omit<T, "execution_receipt"> & { readonly execution_receipt: WorkerExecutionReceipt } {
  const counters: NativeCostCounters = { native_visits: 0, bytes_read: 0, row_visits: 0 };
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const settle = (): WorkerFailureCost => ({
    native_visits: counters.native_visits,
    bytes_read: counters.bytes_read,
    row_visits: counters.row_visits,
    elapsed_ms: performance.now() - started,
    rss_bytes: Math.max(rssBefore, process.memoryUsage().rss),
    rss_sampling_method: RSS_SAMPLING_METHOD
  });
  let result: T;
  let cost: WorkerActualCost;
  try {
    result = run(instrumentObserverReaders(readers, counters));
    const measured = settle();
    if (!completeWorkerCost(measured)) throw new CoreError("OBLIGATION_VIOLATION", "Worker reader reported unknown cost");
    cost = measured;
  } catch (error) {
    // Reads already performed are incurred cost. The refusal boundary carries the
    // measured worker snapshot through the owner's serialized error details; an
    // unmeasured worker cost is never reported as zero.
    attachMeasuredWorkerCost(error, settle());
    throw error;
  }
  const executionReceipt = { ...result.execution_receipt, worker: cost };
  return {
    ...result,
    execution_receipt: executionReceipt,
    ...(result.issue === undefined ? {} : { issue: ((issued) => {
      try {
        const resultValue = result.issue!(issued);
        if (!completeWorkerCost(settle())) throw new CoreError("OBLIGATION_VIOLATION", "Worker reader reported unknown cost");
        return resultValue;
      } catch (error) {
        attachMeasuredWorkerCost(error, settle());
        throw error;
      } finally {
        const measured = settle();
        if (completeWorkerCost(measured)) Object.assign(executionReceipt, result.execution_receipt, { worker: measured });
      }
    }) as NonNullable<T["issue"]> })
  };
}

function completeWorkerCost(cost: WorkerFailureCost): cost is WorkerActualCost {
  return cost.native_visits !== null && cost.bytes_read !== null && cost.row_visits !== null;
}

/** Measured snapshots survive a refusal even when the error object is frozen or has
 * no writable details. Serialization consults this owner instead of guessing.
 */
const MEASURED_FAILURE_COST = new WeakMap<Error, WorkerFailureCost>();

/** Attach the measured worker snapshot to the refusal the worker already serializes. */
export function attachMeasuredWorkerCost(error: unknown, cost: WorkerFailureCost): void {
  if (!(error instanceof Error)) return;
  // An outer acknowledgment may only have an older successful receipt. It
  // cannot replace the newer failure snapshot's explicitly unknown work.
  const previous = MEASURED_FAILURE_COST.get(error);
  if (previous !== undefined && !completeWorkerCost(previous)) return;
  MEASURED_FAILURE_COST.set(error, Object.freeze({ ...cost }));
  const target = error as Error & { details?: Readonly<Record<string, unknown>> };
  const details = target.details ?? {};
  // Preserve properties for callers holding this error. Adapters and serialization
  // read the WeakMap's latest sample rather than mistaking an older property for it.
  if (Object.prototype.hasOwnProperty.call(details, "worker")) return;
  try {
    target.details = Object.freeze({ ...details, worker: Object.freeze({ ...cost }) });
  } catch {
    // A frozen error keeps its classification; serialization still reads the WeakMap.
  }
}

/** Measured cost a serialization owner must preserve for any error classification. */
export function measuredWorkerCostOf(error: unknown): WorkerFailureCost | undefined {
  return error instanceof Error ? MEASURED_FAILURE_COST.get(error) : undefined;
}

/** Error adapters and IPC use the same latest physical snapshot, including immutable
 * errors. Other owner records (work/execution_receipt) are retained without conversion.
 */
export function workerFailureDetails(error: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = (error as Error & { readonly details?: unknown }).details;
  const details = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
  const measured = measuredWorkerCostOf(error);
  return measured === undefined ? details : Object.freeze({ ...details, worker: measured });
}

/** Optional receipt reader; unknown stays absent, never zero. */
export function measuredWorkerCostOfReceipt(
  receipt: ConditionalFieldExecutionReceipt | undefined
): WorkerActualCost | undefined {
  try { return workerActualCostOf(receipt); } catch { return undefined; }
}

export function workerActualCostOf(
  receipt: ConditionalFieldExecutionReceipt | undefined
): WorkerActualCost {
  if (receipt === undefined) throw new Error("execution receipt missing");
  const worker = (receipt as ConditionalFieldExecutionReceipt & {
    readonly worker?: Partial<WorkerActualCost> | null;
  }).worker;
  const nativeVisits = worker?.native_visits;
  const bytesRead = worker?.bytes_read;
  const rowVisits = worker?.row_visits;
  const elapsedMs = worker?.elapsed_ms;
  const rssBytes = worker?.rss_bytes;
  if (
    worker == null
    || nativeVisits === undefined || bytesRead === undefined || rowVisits === undefined
    || elapsedMs === undefined || rssBytes === undefined
    || !Number.isFinite(nativeVisits) || !Number.isFinite(bytesRead)
    || !Number.isFinite(rowVisits) || !Number.isFinite(elapsedMs)
    || !Number.isFinite(rssBytes) || worker.rss_sampling_method !== RSS_SAMPLING_METHOD
  ) {
    throw new Error("worker actual cost missing from execution receipt");
  }
  return {
    native_visits: nativeVisits,
    bytes_read: bytesRead,
    row_visits: rowVisits,
    elapsed_ms: elapsedMs,
    rss_bytes: rssBytes,
    rss_sampling_method: worker.rss_sampling_method
  };
}

function instrumentObserverReaders(
  readers: ObserverReaders,
  counters: NativeCostCounters
): ObserverReaders {
  return {
    ...readers,
    ...(readers.snapshotPin === undefined ? {} : { snapshotPin: (workspaceId: string) => {
      const pin = readers.snapshotPin!(workspaceId);
      counters.native_visits = addKnownCounter(counters.native_visits, SNAPSHOT_PIN_NATIVE_WORK);
      return pin;
    } }),
    ...(readers.lexical === undefined ? {} : {
      lexical: (input) => chargeNativePage(counters, readers.lexical!(input))
    }),
    ...(readers.source === undefined ? {} : {
      source: (input) => chargeNativePage(counters, readers.source!(input))
    }),
    ...(readers.sourceRoots === undefined ? {} : {
      sourceRoots: (input) => chargeNativePage(counters, readers.sourceRoots!(input))
    }),
    ...(readers.sourceRoot === undefined ? {} : {
      sourceRoot: (input) => chargeNativePage(counters, readers.sourceRoot!(input))
    }),
    ...(readers.boundInterpretations === undefined ? {} : {
      boundInterpretations: (input) => chargeNativePage(counters, readers.boundInterpretations!(input))
    }),
    ...(readers.sourceTextHints === undefined ? {} : {
      sourceTextHints: (input) => chargeNativePage(counters, readers.sourceTextHints!(input))
    }),
    ...(readers.relation === undefined ? {} : {
      relation: (input) => chargeNativePage(counters, readers.relation!(input))
    }),
    ...(readers.embeddingIds === undefined ? {} : {
      embeddingIds: (input) => chargeNativePage(counters, readers.embeddingIds!(input))
    }),
    ...(readers.measureStoredPair === undefined ? {} : {
      measureStoredPair: (input) => chargeNativePage(counters, readers.measureStoredPair!(input))
    }),
    ...(readers.measureStoredPairs === undefined ? {} : {
      measureStoredPairs: (input) => chargeNativePage(counters, readers.measureStoredPairs!(input))
    })
  };
}

function chargeNativePage<T extends NativePage>(counters: NativeCostCounters, page: T): T {
  counters.native_visits = addKnownCounter(counters.native_visits, chargedNativeVisits(page));
  counters.row_visits = addKnownCounter(counters.row_visits, page.rowsRead ?? page.rowVisits ?? 0);
  counters.bytes_read = addKnownCounter(counters.bytes_read, page.bytesRead ?? 0);
  counters.bytes_read = addKnownCounter(counters.bytes_read, page.metadataBytes ?? page.metadataUtf8Bytes ?? 0);
  return page;
}

function addKnownCounter(total: number | null, increment: number): number | null {
  if (total === null || !Number.isSafeInteger(increment) || increment < 0) return null;
  const next = total + increment;
  return Number.isSafeInteger(next) ? next : null;
}

function chargedNativeVisits(page: NativePage): number {
  // Explicit 0 visits still leave nativeWork (empty source-root pages charge 1).
  if (page.nativeVisits !== undefined && (page.nativeVisits !== 0 || page.nativeWork === undefined)) {
    return page.nativeVisits;
  }
  return page.nativeWork ?? page.rowVisits ?? page.rowsRead ?? 0;
}
