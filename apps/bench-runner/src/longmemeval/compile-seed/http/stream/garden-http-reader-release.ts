export function releaseGardenHttpReader(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  completed: boolean
): void {
  if (completed) {
    reader.releaseLock();
    return;
  }
  void cancelAndRelease(reader);
}

async function cancelAndRelease(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation failure must not retain the reader lock.
  }
  try {
    reader.releaseLock();
  } catch {
    // Cleanup remains best-effort after the read path has already settled.
  }
}
