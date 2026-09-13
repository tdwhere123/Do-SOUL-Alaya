export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  public constructor(private readonly maxEntries: number) {}

  public get size(): number {
    return this.entries.size;
  }

  public has(key: K): boolean {
    return this.entries.has(key);
  }

  public get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  public set(
    key: K,
    value: V,
    options: { readonly blocksEviction?: (key: K) => boolean } = {}
  ): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      this.evictOldestAllowed(options.blocksEviction);
    }
    this.entries.set(key, value);
  }

  public setWithEvictionNotice(key: K, value: V, onEvict: (evictedKey: K, evictedValue: V) => void): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.oldestKey();
      if (oldestKey !== undefined) {
        const evictedValue = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        if (evictedValue !== undefined) {
          onEvict(oldestKey, evictedValue);
        }
      }
    }
    this.entries.set(key, value);
  }

  public forEach(callback: (value: V, key: K) => void): void {
    for (const [key, value] of this.entries) {
      callback(value, key);
    }
  }

  public delete(key: K): boolean {
    return this.entries.delete(key);
  }

  public oldestKey(): K | undefined {
    return this.entries.keys().next().value;
  }

  public deleteOldest(): V | undefined {
    const oldestKey = this.oldestKey();
    if (oldestKey === undefined) {
      return undefined;
    }
    const value = this.entries.get(oldestKey);
    this.entries.delete(oldestKey);
    return value;
  }

  private evictOldestAllowed(blocksEviction?: (key: K) => boolean): void {
    if (blocksEviction === undefined) {
      this.deleteOldest();
      return;
    }
    for (const key of this.entries.keys()) {
      if (blocksEviction(key)) {
        continue;
      }
      this.entries.delete(key);
      return;
    }
    // Prefer temporary oversize over evicting a blocked entry.
  }
}
