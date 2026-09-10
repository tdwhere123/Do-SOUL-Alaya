import { performance } from "node:perf_hooks";
import type {
  ConditionalFieldExecutionReceipt,
  ObserverReaders
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

export type WorkerExecutionReceipt = ConditionalFieldExecutionReceipt & WorkerActualCost;

type NativeCostCounters = {
  native_visits: number;
  bytes_read: number;
  row_visits: number;
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
}>(
  readers: ObserverReaders,
  run: (readers: ObserverReaders) => T
): T {
  const counters: NativeCostCounters = { native_visits: 0, bytes_read: 0, row_visits: 0 };
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const result = run(instrumentObserverReaders(readers, counters));
  const rssAfter = process.memoryUsage().rss;
  const cost: WorkerActualCost = {
    native_visits: counters.native_visits,
    bytes_read: counters.bytes_read,
    row_visits: counters.row_visits,
    elapsed_ms: performance.now() - started,
    rss_bytes: Math.max(rssBefore, rssAfter),
    rss_sampling_method: RSS_SAMPLING_METHOD
  };
  return {
    ...result,
    execution_receipt: { ...result.execution_receipt, ...cost } as T["execution_receipt"]
  };
}

export function workerActualCostOf(
  receipt: ConditionalFieldExecutionReceipt | undefined
): WorkerActualCost {
  if (receipt === undefined) throw new Error("execution receipt missing");
  const row = receipt as ConditionalFieldExecutionReceipt & Partial<WorkerActualCost>;
  const nativeVisits = row.native_visits;
  const bytesRead = row.bytes_read;
  const rowVisits = row.row_visits;
  const elapsedMs = row.elapsed_ms;
  const rssBytes = row.rss_bytes;
  if (
    nativeVisits === undefined || bytesRead === undefined || rowVisits === undefined
    || elapsedMs === undefined || rssBytes === undefined
    || !Number.isFinite(nativeVisits) || !Number.isFinite(bytesRead)
    || !Number.isFinite(rowVisits) || !Number.isFinite(elapsedMs)
    || !Number.isFinite(rssBytes) || row.rss_sampling_method !== RSS_SAMPLING_METHOD
  ) {
    throw new Error("worker actual cost missing from execution receipt");
  }
  return {
    native_visits: nativeVisits,
    bytes_read: bytesRead,
    row_visits: rowVisits,
    elapsed_ms: elapsedMs,
    rss_bytes: rssBytes,
    rss_sampling_method: row.rss_sampling_method
  };
}

function instrumentObserverReaders(
  readers: ObserverReaders,
  counters: NativeCostCounters
): ObserverReaders {
  return {
    ...readers,
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
    ...(readers.relation === undefined ? {} : {
      relation: (input) => chargeNativePage(counters, readers.relation!(input))
    }),
    ...(readers.embeddingIds === undefined ? {} : {
      embeddingIds: (input) => chargeNativePage(counters, readers.embeddingIds!(input))
    }),
    ...(readers.measureStoredPair === undefined ? {} : {
      measureStoredPair: (input) => chargeNativePage(counters, readers.measureStoredPair!(input))
    })
  };
}

function chargeNativePage<T extends NativePage>(counters: NativeCostCounters, page: T): T {
  counters.native_visits += chargedNativeVisits(page);
  counters.row_visits += page.rowsRead ?? page.rowVisits ?? 0;
  counters.bytes_read += page.bytesRead ?? 0;
  counters.bytes_read += page.metadataBytes ?? page.metadataUtf8Bytes ?? 0;
  return page;
}

function chargedNativeVisits(page: NativePage): number {
  // Explicit 0 visits still leave nativeWork (empty source-root pages charge 1).
  if (page.nativeVisits !== undefined && (page.nativeVisits !== 0 || page.nativeWork === undefined)) {
    return page.nativeVisits;
  }
  return page.nativeWork ?? page.rowVisits ?? 0;
}
