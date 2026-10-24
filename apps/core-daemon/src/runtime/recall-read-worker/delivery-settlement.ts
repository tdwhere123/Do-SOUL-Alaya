import { CoreError } from "@do-soul/alaya-core";

/** Private IPC arbitration for one asynchronous acknowledgment. This is not a
 * rollback: cancellation can win only before the prepared owner claims issuance.
 * Once claimed, the synchronous Core issuer alone determines success/failure.
 */
const PENDING = 0, CANCELLED = 1, ISSUING = 2, COMMITTED = 3, FAILED = 4;

export function createDeliverySettlement(signal?: AbortSignal) {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(buffer);
  const cancel = () => { Atomics.compareExchange(state, 0, PENDING, CANCELLED); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return { buffer, dispose: () => signal?.removeEventListener("abort", cancel) };
}

/** The CAS is the cancellation/issuance ordering point, immediately before Core's
 * synchronous issue. A late cancel cannot relabel a committed exposure as aborted.
 */
export function claimDeliverySettlement(buffer: SharedArrayBuffer | undefined): boolean {
  if (buffer === undefined) return true;
  const previous = Atomics.compareExchange(new Int32Array(buffer), 0, PENDING, ISSUING);
  if (previous === CANCELLED) return false;
  if (previous !== PENDING) throw new CoreError("CONFLICT", "Recall acknowledgment arbitration already consumed");
  return true;
}

export function finishDeliverySettlement(buffer: SharedArrayBuffer | undefined, committed: boolean): void {
  if (buffer !== undefined) Atomics.store(new Int32Array(buffer), 0, committed ? COMMITTED : FAILED);
}
