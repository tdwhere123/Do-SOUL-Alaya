type NormalizeCachedValue<Value> = (value: Value) => Value | undefined;

const VERSIONED_BOUNDED_CACHE_MAX_ENTRIES = 1024;

export class VersionedBoundedCache<Value> {
  private readonly store = new Map<string, Value>();
  private readonly pendingLoads = new Map<string, Promise<Value | undefined>>();
  private readonly versions = new Map<string, number>();
  private epoch = 0;
  private readonly maxEntries: number;

  public constructor(options?: { readonly maxEntries?: number }) {
    this.maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? VERSIONED_BOUNDED_CACHE_MAX_ENTRIES));
  }

  public get size(): number {
    return this.store.size;
  }

  public entries(): IterableIterator<[string, Value]> {
    return this.store.entries();
  }

  public set(key: string, value: Value): void {
    this.bump(key);
    this.write(key, value);
  }

  public delete(key: string): void {
    this.bump(key);
    this.store.delete(key);
    this.pendingLoads.delete(key);
    this.clearVersionIfIdle(key);
  }

  public invalidate(): void {
    this.epoch += 1;
    this.store.clear();
    this.pendingLoads.clear();
    this.versions.clear();
  }

  public refresh(key: string, normalize: NormalizeCachedValue<Value>): Value | undefined {
    const cached = this.store.get(key);
    if (cached === undefined) {
      return undefined;
    }

    const normalized = normalize(cached);
    if (normalized === cached) {
      return cached;
    }

    this.bump(key);
    if (normalized === undefined) {
      this.store.delete(key);
      this.clearVersionIfIdle(key);
      return undefined;
    }

    this.write(key, normalized);
    return normalized;
  }

  public async resolve(
    key: string,
    load: () => Promise<Value | undefined>,
    normalize: NormalizeCachedValue<Value>
  ): Promise<Value | undefined> {
    if (this.store.has(key)) {
      const cached = this.store.get(key);
      const value = this.refresh(key, normalize);
      if (value !== undefined && value === cached) {
        this.touch(key);
      }
      return value;
    }

    const pending = this.pendingLoads.get(key);
    if (pending !== undefined) {
      return pending;
    }

    return this.startLoad(key, load, normalize);
  }

  private startLoad(
    key: string,
    load: () => Promise<Value | undefined>,
    normalize: NormalizeCachedValue<Value>
  ): Promise<Value | undefined> {
    const epochBeforeLoad = this.epoch;
    const versionBeforeLoad = this.version(key);
    const promise = load()
      .then((loaded) => this.finishLoad(key, loaded, normalize, epochBeforeLoad, versionBeforeLoad))
      .finally(() => this.finishPending(key, promise));
    this.pendingLoads.set(key, promise);
    return promise;
  }

  private finishLoad(
    key: string,
    loaded: Value | undefined,
    normalize: NormalizeCachedValue<Value>,
    epochBeforeLoad: number,
    versionBeforeLoad: number
  ): Value | undefined {
    if (this.epoch !== epochBeforeLoad || this.version(key) !== versionBeforeLoad || this.store.has(key)) {
      const current = this.refresh(key, normalize);
      if (current !== undefined) {
        return current;
      }
      // Generation moved; give the waiter its load without caching it.
      return loaded === undefined ? undefined : normalize(loaded);
    }

    const normalized = loaded === undefined ? undefined : normalize(loaded);
    if (normalized !== undefined) {
      this.write(key, normalized);
    }
    return normalized;
  }

  private write(key: string, value: Value): void {
    this.store.delete(key);
    this.store.set(key, value);
    this.evictOverflow();
  }

  private touch(key: string): void {
    const value = this.store.get(key);
    if (value === undefined) {
      return;
    }
    this.store.delete(key);
    this.store.set(key, value);
  }

  private evictOverflow(): void {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
      this.clearVersionIfIdle(oldestKey);
    }
  }

  private finishPending(key: string, promise: Promise<Value | undefined>): void {
    if (this.pendingLoads.get(key) === promise) {
      this.pendingLoads.delete(key);
    }
    this.clearVersionIfIdle(key);
  }

  private version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  private bump(key: string): void {
    this.versions.set(key, this.version(key) + 1);
  }

  private clearVersionIfIdle(key: string): void {
    if (!this.store.has(key) && !this.pendingLoads.has(key)) {
      this.versions.delete(key);
    }
  }
}
