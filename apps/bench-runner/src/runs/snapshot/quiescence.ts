import { drainAuditedAsyncSideEffects } from "@do-soul/alaya-core";

const SNAPSHOT_QUIESCENCE_TIMEOUT_MS = 30_000;

export async function awaitLongMemEvalSnapshotQuiescence(): Promise<void> {
  await drainAuditedAsyncSideEffects({
    timeoutMs: SNAPSHOT_QUIESCENCE_TIMEOUT_MS
  });
}
