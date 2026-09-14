// Per-key in-process async mutex for read-decide-write sections that share a key.
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `task` with exclusive access for `key`. Tasks for the same key
   * run strictly one at a time, in arrival order; tasks for distinct
   * keys run concurrently. The lock is always released, including when
   * `task` throws.
   */
  public async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The stored tail is the chained promise, not `current`; cleanup must
    // compare against the same object that was stored or the map entry leaks.
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

  /** Live promise-chain tails; drains to zero when no key is held or queued. */
  public get trackedKeyCount(): number {
    return this.tails.size;
  }
}
