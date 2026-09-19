export type SourceSemanticResourceBudget = Readonly<{ work_units: number; memory_bytes: number }>;

export class SourceSemanticResourceExhausted extends Error {
  constructor(readonly phase: string) { super(`source semantic ${phase} budget exhausted`); }
}

/** Conservative logical allocations/work; not a wall-clock guarantee or an RSS bound. */
export class SourceSemanticResourceLedger {
  public work: number;
  public bytes: number;
  public spentWork = 0;
  public spentBytes = 0;
  constructor(budget: SourceSemanticResourceBudget) { this.work = budget.work_units; this.bytes = budget.memory_bytes; }
  reserve(work: number, bytes: number, phase = "preparation"): void {
    if (!Number.isSafeInteger(work) || !Number.isSafeInteger(bytes) || work < 0 || bytes < 0
      || work > this.work || bytes > this.bytes) throw new SourceSemanticResourceExhausted(phase);
  }
  charge(work: number, bytes: number, phase = "preparation"): void {
    this.reserve(work, bytes, phase);
    this.work -= work; this.bytes -= bytes; this.spentWork += work; this.spentBytes += bytes;
  }
  /** Bound traversal and copies before schema validation or canonicalization. */
  retain(value: unknown, phase = "preparation"): void {
    const pending: unknown[] = [value];
    while (pending.length > 0) {
      const row = pending.pop();
      this.charge(1, typeof row === "string" ? 24 + 4 * row.length : 64, phase);
      if (row === null || typeof row !== "object") continue;
      if (Array.isArray(row)) {
        this.charge(0, row.length * 8, phase);
        this.reserve(row.length, 0, phase);
        for (const item of row) pending.push(item);
      } else {
        const keys = Object.keys(row);
        this.charge(0, keys.reduce((size, key) => size + 24 + 4 * key.length, 0), phase);
        this.reserve(keys.length, 0, phase);
        for (const key of keys) pending.push((row as Record<string, unknown>)[key]);
      }
    }
  }
  remaining(): SourceSemanticResourceBudget { return { work_units: this.work, memory_bytes: this.bytes }; }
}
