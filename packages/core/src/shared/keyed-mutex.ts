// invariant: a per-key in-process async mutex. Serializes async critical
// sections that share a key so a read-decide-write sequence cannot
// interleave with another for the same key. Closes a TOCTOU window when
// the work cannot be wrapped in a single DB transaction (e.g. the
// decision step makes a network call). The Garden runs fire-and-forget
// in one process, so a process-local lock is sufficient — there is no
// second writer process to coordinate with.
// see also: packages/core/src/reconciliation-service.ts

export class KeyedMutex {
  // Per key: the tail of the promise chain. A new acquirer awaits the
  // current tail, then becomes the new tail until it releases.
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
    // The stored tail is the chained promise, not `current`; the cleanup
    // identity check below must compare against the SAME object that was
    // stored or it never matches and the map entry leaks per key.
    const chained = previous.then(() => current);
    this.tails.set(key, chained);

    await previous;
    try {
      return await task();
    } finally {
      release();
      // Drop the map entry when this task is the chain tail so an idle
      // key does not retain memory. A racing acquirer that already
      // replaced the tail with its own chained promise keeps that entry.
      if (this.tails.get(key) === chained) {
        this.tails.delete(key);
      }
    }
  }

  /** Number of keys with a live promise-chain tail. Drains to 0 when no
   *  task holds or is queued on any key — the no-leak observability
   *  hook the cleanup branch above must satisfy. */
  public get trackedKeyCount(): number {
    return this.tails.size;
  }
}
