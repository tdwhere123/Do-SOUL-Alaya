export type SourceSemanticResourceBudget = Readonly<{ work_units: number; memory_bytes: number }>;

export class SourceSemanticResourceExhausted extends Error {
  constructor(readonly phase: string) { super(`source semantic ${phase} budget exhausted`); }
}

type RetainedKind = "scalar" | "array" | "object";
// These contain frozen numeric snapshots, never caller-supplied costs or mutable payload references.
const PRICES = new WeakMap<SourceSemanticResourceBudget, RetainedKind>();
const IMMUTABLE_PRICES = new WeakMap<object, SourceSemanticResourceBudget>();
const nodeBytes = (value: unknown): number => typeof value === "string" ? 24 + 4 * value.length : 64;
const kindOf = (value: unknown): RetainedKind => value === null || typeof value !== "object" ? "scalar"
  : Array.isArray(value) ? "array" : "object";
function retainedPrice(value: unknown): SourceSemanticResourceBudget | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return PRICES.has(value as SourceSemanticResourceBudget) ? value as SourceSemanticResourceBudget : IMMUTABLE_PRICES.get(value);
}

function issuePrice(cost: SourceSemanticResourceBudget, kind: RetainedKind,
  planner?: SourceSemanticResourceLedger, phase = "retained price snapshot allocation"): SourceSemanticResourceBudget {
  if (!Number.isSafeInteger(cost.work_units) || !Number.isSafeInteger(cost.memory_bytes)
    || cost.work_units < 0 || cost.memory_bytes < 0) throw new SourceSemanticResourceExhausted("retained price range");
  const snapshot = Object.freeze({ work_units: cost.work_units, memory_bytes: cost.memory_bytes });
  planner?.retain(snapshot, phase);
  planner?.charge(1, 16, phase);
  PRICES.set(snapshot, kind);
  return snapshot;
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
  retain(value: unknown, phase = "preparation", ownership?: "immutable"): void {
    const work = this.spentWork, bytes = this.spentBytes;
    const freezeWork = traverseRetained(value, this, phase, undefined, false, ownership === "immutable");
    if (ownership === "immutable" && value !== null && typeof value === "object") {
      const cost = issuePrice({ work_units: this.spentWork - work - freezeWork, memory_bytes: this.spentBytes - bytes }, kindOf(value), this, phase);
      this.charge(1, 16, phase);
      IMMUTABLE_PRICES.set(value, cost);
    }
  }
  /** Quote expressions may contain earlier issued numeric prices. Actual retain never interprets them.
   * Owned immutable payloads reuse the exact price captured by their executed retention traversal. */
  static quoteRetain(value: unknown, allowance: SourceSemanticResourceBudget,
    planner?: SourceSemanticResourceLedger): SourceSemanticResourceBudget {
    const measured = new SourceSemanticResourceLedger(allowance);
    traverseRetained(value, measured, "retained value quote", planner, true);
    return retainedPrice(value) ?? issuePrice({ work_units: measured.spentWork, memory_bytes: measured.spentBytes }, kindOf(value), planner);
  }
  /** Overlay object frames using only validated numeric snapshots. Duplicate fields overquote, never underquote. */
  static overlayRetainObjects(left: SourceSemanticResourceBudget, right: SourceSemanticResourceBudget,
    planner?: SourceSemanticResourceLedger): SourceSemanticResourceBudget {
    const a = PRICES.get(left), b = PRICES.get(right);
    if (a !== "object" || b !== "object") throw new SourceSemanticResourceExhausted("retained object price composition");
    planner?.charge(2, 0, "retained object price composition");
    return issuePrice({ work_units: left.work_units + right.work_units - 1,
      memory_bytes: left.memory_bytes + right.memory_bytes - nodeBytes(null) }, "object", planner);
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
  planner?: SourceSemanticResourceLedger, quote = false, immutable = false): number {
  const charge = (work: number, bytes: number) => {
    planner?.charge(work, bytes, "retained value measurement work");
    meter.charge(work, bytes, phase);
  };
  const reserve = (work: number, bytes: number) => {
    planner?.reserve(work, bytes, "retained value measurement work");
    meter.reserve(work, bytes, phase);
  };
  let freezeWork = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const row = pending.pop();
    const price = quote ? retainedPrice(row) : undefined;
    if (price !== undefined) {
      planner?.charge(1, 0, "retained numeric price reference");
      meter.charge(price.work_units, price.memory_bytes, phase);
      continue;
    }
    charge(1, nodeBytes(row));
    if (row === null || typeof row !== "object") continue;
    const array = Array.isArray(row), keys = array ? undefined : Object.keys(row);
    charge(0, array ? row.length * 8 : keys!.reduce((size, key) => size + 24 + 4 * key.length, 0));
    reserve(array ? row.length : keys!.length, 0);
    if (immutable) {
      // Freeze only owned plain data. Accessors, custom prototypes and symbols cannot certify a stable price.
      charge(1, 0); freezeWork++;
      const prototype = Object.getPrototypeOf(row);
      if (prototype !== (Array.isArray(row) ? Array.prototype : Object.prototype) && prototype !== null) {
        throw new SourceSemanticResourceExhausted(`${phase} immutable data prototype`);
      }
      if (Array.isArray(row) && Object.keys(row).length !== row.length) {
        throw new SourceSemanticResourceExhausted(`${phase} immutable dense array`);
      }
      for (const key of Reflect.ownKeys(row)) {
        charge(1, 0); freezeWork++;
        if (typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(row, key)!)
          || Array.isArray(row) && key !== "length" && (String(Number(key)) !== key || Number(key) < 0 || Number(key) >= row.length)) {
          throw new SourceSemanticResourceExhausted(`${phase} immutable data property`);
        }
      }
      Object.freeze(row);
    }
    if (array) for (const item of row) pending.push(item);
    else for (const key of keys!) pending.push((row as Record<string, unknown>)[key]);
  }
  return freezeWork;
}
