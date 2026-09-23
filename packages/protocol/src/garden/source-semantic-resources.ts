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
    traverseRetained(value, this, phase);
  }
  /** Measure with the same bounded debit sequence; an optional planner pays as traversal runs. */
  static measureRetain(value: unknown, allowance: SourceSemanticResourceBudget,
    planner?: SourceSemanticResourceLedger): SourceSemanticResourceBudget {
    const measured = new SourceSemanticResourceLedger(allowance);
    traverseRetained(value, measured, "retained value measurement", planner);
    return { work_units: measured.spentWork, memory_bytes: measured.spentBytes };
  }
  remaining(): SourceSemanticResourceBudget { return { work_units: this.work, memory_bytes: this.bytes }; }
}

function traverseRetained(value: unknown, meter: SourceSemanticResourceLedger, phase: string,
  planner?: SourceSemanticResourceLedger): void {
  const charge = (work: number, bytes: number) => {
    planner?.charge(work, bytes, "retained value measurement work");
    meter.charge(work, bytes, phase);
  };
  const reserve = (work: number, bytes: number) => {
    planner?.reserve(work, bytes, "retained value measurement work");
    meter.reserve(work, bytes, phase);
  };
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const row = pending.pop();
    charge(1, typeof row === "string" ? 24 + 4 * row.length : 64);
    if (row === null || typeof row !== "object") continue;
    if (Array.isArray(row)) {
      charge(0, row.length * 8);
      reserve(row.length, 0);
      for (const item of row) pending.push(item);
    } else {
      const keys = Object.keys(row);
      charge(0, keys.reduce((size, key) => size + 24 + 4 * key.length, 0));
      reserve(keys.length, 0);
      for (const key of keys) pending.push((row as Record<string, unknown>)[key]);
    }
  }
}
