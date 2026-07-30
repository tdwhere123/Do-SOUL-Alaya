/** Bounded LRU of (modelId, query, passage) → score for local CE rerank. */

export class CrossEncoderScoreCache {
  private readonly entries = new Map<string, number>();

  public constructor(
    private readonly modelId: string,
    private readonly maxEntries: number
  ) {}

  public get enabled(): boolean {
    return this.maxEntries > 0;
  }

  public get(query: string, passage: string): number | undefined {
    if (!this.enabled) return undefined;
    const key = this.key(query, passage);
    const cached = this.entries.get(key);
    if (cached === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached;
  }

  public set(query: string, passage: string, score: number): void {
    if (!this.enabled) return;
    const key = this.key(query, passage);
    this.entries.delete(key);
    this.entries.set(key, score);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private key(query: string, passage: string): string {
    return `${this.modelId}\0${query}\0${passage}`;
  }
}
