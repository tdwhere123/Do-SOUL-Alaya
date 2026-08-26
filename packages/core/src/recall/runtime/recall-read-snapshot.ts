export interface RecallReadSnapshotPort {
  beginDeferred(): void;
  commit(): void;
  rollback(): void;
}

export async function withRecallReadSnapshot<T>(
  snapshot: RecallReadSnapshotPort | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (snapshot === undefined) {
    return await work();
  }
  snapshot.beginDeferred();
  try {
    const result = await work();
    snapshot.commit();
    return result;
  } catch (error) {
    try {
      snapshot.rollback();
    } catch {
      // Primary recall failure owns the throw; rollback is best-effort.
    }
    throw error;
  }
}
