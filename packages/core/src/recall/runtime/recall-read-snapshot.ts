export interface RecallReadSnapshotPort {
  beginDeferred(): void | Promise<void>;
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
  isolate?<T>(work: () => Promise<T>): Promise<T>;
}

declare const activeRecallReadCapabilityBrand: unique symbol;

export type ActiveRecallReadCapability = Readonly<{
  readonly [activeRecallReadCapabilityBrand]: true;
}>;

const activeCapabilities = new WeakSet<object>();

export function isActiveRecallReadCapability(
  capability: unknown
): capability is ActiveRecallReadCapability {
  return typeof capability === "object" && capability !== null &&
    activeCapabilities.has(capability);
}

export async function withRecallReadSnapshot<T>(
  snapshot: RecallReadSnapshotPort | undefined,
  work: () => Promise<T>
): Promise<T> {
  return await withActiveRecallReadSnapshot(snapshot, async () => await work());
}

export async function withActiveRecallReadSnapshot<T>(
  snapshot: RecallReadSnapshotPort | undefined,
  work: (capability: ActiveRecallReadCapability | undefined) => Promise<T>
): Promise<T> {
  if (snapshot === undefined) {
    return await work(undefined);
  }
  const run = snapshot.isolate !== undefined
    ? (inner: () => Promise<T>) => snapshot.isolate!(inner)
    : (inner: () => Promise<T>) => inner();
  return await run(async () => {
    await snapshot.beginDeferred();
    const capability = Object.freeze({}) as ActiveRecallReadCapability;
    activeCapabilities.add(capability);
    try {
      const result = await work(capability);
      await snapshot.commit();
      return result;
    } catch (error) {
      try {
        await snapshot.rollback();
      } catch {
        // Primary recall failure owns the throw; rollback is best-effort.
      }
      throw error;
    } finally {
      activeCapabilities.delete(capability);
    }
  });
}
