export interface RecallReadSnapshotPort {
  beginDeferred(): void | Promise<void>;
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
  isolate?<T>(work: () => Promise<T>): Promise<T>;
}

export async function withRecallReadSnapshot<T>(
  snapshot: RecallReadSnapshotPort | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (snapshot === undefined) {
    return await work();
  }
  const run = snapshot.isolate !== undefined
    ? (inner: () => Promise<T>) => snapshot.isolate!(inner)
    : (inner: () => Promise<T>) => inner();
  return await run(async () => {
    await snapshot.beginDeferred();
    try {
      const result = await work();
      await snapshot.commit();
      return result;
    } catch (error) {
      try {
        await snapshot.rollback();
      } catch {
        // Primary recall failure owns the throw; rollback is best-effort.
      }
      throw error;
    }
  });
}
