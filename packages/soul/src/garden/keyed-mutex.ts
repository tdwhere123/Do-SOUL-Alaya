// Per-key in-process async mutex: serializes read-decide-(await)-write
// sections sharing a key so two cannot interleave. Garden runs
// fire-and-forget in one process, so a process-local lock suffices.
// Local to soul because invariant §6 forbids Garden importing packages/core.
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `task` with exclusive access for `key`; same-key tasks run one at
   *  a time in arrival order. The lock releases even when `task` throws. */
  public async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Store the chained promise (not `current`) so the cleanup identity check matches.
    const chained = previous.then(() => current);
    this.tails.set(key, chained);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === chained) {
        this.tails.delete(key);
      }
    }
  }
}
