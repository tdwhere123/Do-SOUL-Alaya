import type { BenchDaemonHandle } from "../../../harness/daemon.js";

type Observed = Awaited<ReturnType<NonNullable<BenchDaemonHandle["observeSourceSemantics"]>>>;
export type OrdinaryEntryObservation = Readonly<Pick<Observed, "status" | "observations">>;
export type CaptureOrdinaryEntryObservation = (queryKey: string, observation: OrdinaryEntryObservation) => void;

/** Private opt-in around the same public calls; absent capture preserves the ordinary path. */
export async function observeOrdinaryEntry<T>(daemon: BenchDaemonHandle, queryKey: string,
  work: () => Promise<T>, capture?: CaptureOrdinaryEntryObservation): Promise<T> {
  if (capture === undefined) return work();
  if (daemon.observeSourceSemantics === undefined) {
    const result = await work();
    try { capture(queryKey, { status: "unavailable", observations: [] }); } catch { /* Diagnostics cannot change delivery. */ }
    return result;
  }
  const observed = await daemon.observeSourceSemantics({
    max_events: 2048, max_bytes: 524288, rank_prefix: 50, capture_query_vector: true, capture_page_attempts: true
  }, work);
  try { capture(queryKey, { status: observed.status, observations: observed.observations }); }
  catch { /* Diagnostics cannot replace the ordinary outcome or its error. */ }
  if (observed.outcome.status === "failure") throw observed.outcome.error;
  return observed.outcome.value;
}
