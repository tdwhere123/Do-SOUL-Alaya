export class LruCache<K, V> {
  // Daemon-local copy: middleware must not import @do-soul/alaya-storage for LRU.
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

  public set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      this.deleteOldest();
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

  public delete(key: K): boolean {
    return this.entries.delete(key);
  }

  public forEach(callback: (value: V, key: K) => void): void {
    for (const [key, value] of this.entries) {
      callback(value, key);
    }
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
}
