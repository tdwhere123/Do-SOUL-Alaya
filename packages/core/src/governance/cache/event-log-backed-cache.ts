type NormalizeCachedValue<Value> = (value: Value) => Value | undefined;

export class EventLogBackedCache<Value> {
  private readonly store = new Map<string, Value>();
  private readonly pendingLoads = new Map<string, Promise<Value | undefined>>();
  private readonly versions = new Map<string, number>();

  public entries(): IterableIterator<[string, Value]> {
    return this.store.entries();
  }

  public set(key: string, value: Value): void {
    this.bump(key);
    this.store.set(key, value);
  }

  public delete(key: string): void {
    this.bump(key);
    this.store.delete(key);
    this.clearVersionIfIdle(key);
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

    this.store.set(key, normalized);
    return normalized;
  }

  public async resolve(
    key: string,
    load: () => Promise<Value | undefined>,
    normalize: NormalizeCachedValue<Value>
  ): Promise<Value | undefined> {
    if (this.store.has(key)) {
      return this.refresh(key, normalize);
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
    const versionBeforeLoad = this.version(key);
    const promise = load()
      .then((loaded) => this.finishLoad(key, loaded, normalize, versionBeforeLoad))
      .finally(() => this.finishPending(key, promise));
    this.pendingLoads.set(key, promise);
    return promise;
  }

  private finishLoad(
    key: string,
    loaded: Value | undefined,
    normalize: NormalizeCachedValue<Value>,
    versionBeforeLoad: number
  ): Value | undefined {
    if (this.version(key) !== versionBeforeLoad || this.store.has(key)) {
      return this.refresh(key, normalize);
    }

    const normalized = loaded === undefined ? undefined : normalize(loaded);
    if (normalized !== undefined) {
      this.store.set(key, normalized);
    }
    return normalized;
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
