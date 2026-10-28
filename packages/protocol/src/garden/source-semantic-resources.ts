import { canonicalJsonLength } from "../recall/selection/capture/canonical-json.js";

export type SourceSemanticResourceBudget = Readonly<{ work_units: number; memory_bytes: number }>;

export class SourceSemanticResourceExhausted extends Error {
  constructor(readonly phase: string, readonly constraints?: Readonly<{
    work?: Readonly<{ required: number; available: number }>;
    memory?: Readonly<{ required: number; available: number }>;
  }>) { super(`source semantic ${phase} budget exhausted`); }
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

type Meter = Pick<SourceSemanticResourceLedger, "charge" | "retain">;
function freezeOwned(row: object, charge: (work: number, bytes: number) => void, phase: string): number {
  let work = 1;
  charge(1, 0);
  const array = Array.isArray(row), prototype = Object.getPrototypeOf(row);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
    throw new SourceSemanticResourceExhausted(`${phase} immutable data prototype`);
  }
  if (array && Object.keys(row).length !== row.length) {
    throw new SourceSemanticResourceExhausted(`${phase} immutable dense array`);
  }
  for (const key of Reflect.ownKeys(row)) {
    charge(1, 0); work++;
    if (typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(row, key)!)
      || array && key !== "length" && (String(Number(key)) !== key || Number(key) < 0 || Number(key) >= row.length)) {
      throw new SourceSemanticResourceExhausted(`${phase} immutable data property`);
    }
  }
  Object.freeze(row);
  return work;
}

/** Conservative logical allocations/work; not a wall-clock guarantee or an RSS bound. */
export class SourceSemanticResourceLedger {
  public work: number;
  public bytes: number;
  public spentWork = 0;
  public spentBytes = 0;
  constructor(budget: SourceSemanticResourceBudget) { this.work = budget.work_units; this.bytes = budget.memory_bytes; }
  reserve(work: number, bytes: number, phase = "preparation"): void {
    if (!Number.isSafeInteger(work) || !Number.isSafeInteger(bytes) || work < 0 || bytes < 0) {
      throw new SourceSemanticResourceExhausted(phase);
    }
    if (work > this.work || bytes > this.bytes) throw new SourceSemanticResourceExhausted(phase, {
      ...(work > this.work ? { work: { required: work, available: this.work } } : {}),
      ...(bytes > this.bytes ? { memory: { required: bytes, available: this.bytes } } : {})
    });
  }
  charge(work: number, bytes: number, phase = "preparation"): void {
    this.reserve(work, bytes, phase);
    this.work -= work; this.bytes -= bytes; this.spentWork += work; this.spentBytes += bytes;
  }
  /** Capture through the validator once, then freeze only its newly owned plain data. */
  static capture<T extends object>(value: unknown, parse: (value: unknown) => T, phase: string, meter?: Meter,
    allocation: "retained" | "packing_intermediate" = "retained"): T {
    if (allocation === "retained") meter?.retain(value, phase);
    else captureFrames(value, meter, phase);
    const owned = parse(value), pending: unknown[] = [owned];
    meter?.charge(0, 8, phase);
    while (pending.length > 0) {
      const row = pending.pop();
      if (row === null || typeof row !== "object") continue;
      freezeOwned(row, (work, bytes) => meter?.charge(work, bytes, phase), phase);
      const values = Object.values(row);
      meter?.charge(0, values.length * 8, phase);
      pending.push(...values);
    }
    return owned;
  }
  /** Bound traversal and copies before schema validation or canonicalization. */
  retain(value: unknown, phase = "preparation", ownership?: "immutable" | "borrow"): void {
    const work = this.spentWork, bytes = this.spentBytes;
    const freezeWork = traverseRetained(value, this, phase, undefined, false, ownership === "immutable", ownership === "borrow");
    if (ownership === "immutable" && value !== null && typeof value === "object") {
      const cost = issuePrice({ work_units: this.spentWork - work - freezeWork, memory_bytes: this.spentBytes - bytes }, kindOf(value), this, phase);
      this.charge(1, 16, phase);
      IMMUTABLE_PRICES.set(value, cost);
    }
  }
  /** Quote expressions may contain earlier issued numeric prices. Actual retain never interprets them.
   * Owned immutable payloads reuse the exact price captured by their executed retention traversal. */
  static quoteRetain(value: unknown, allowance: SourceSemanticResourceBudget,
    planner?: SourceSemanticResourceLedger, ownership?: "borrow"): SourceSemanticResourceBudget {
    const measured = new SourceSemanticResourceLedger(allowance);
    traverseRetained(value, measured, "retained value quote", planner, true, false, ownership === "borrow");
    return (ownership === "borrow" ? undefined : retainedPrice(value))
      ?? issuePrice({ work_units: measured.spentWork, memory_bytes: measured.spentBytes }, kindOf(value), planner);
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
  /** Run a capacity-only canonical scan on this ledger, or mirror it into a planner.
   * Unlike retain/borrow, sizing must visit the contents of owned immutable payloads. */
  canonicalJsonLength(value: unknown, planner?: SourceSemanticResourceLedger): number {
    if (planner === undefined) return canonicalJsonLength(value, this);
    return canonicalJsonLength(value, { charge: (work, bytes, phase) => {
      planner.charge(work, bytes, phase);
      this.charge(work, bytes, phase);
    } });
  }
  /** Quote the same executed size scan, including its small numeric encodings. */
  static measureCanonicalJsonLength(value: unknown, allowance: SourceSemanticResourceBudget,
    planner?: SourceSemanticResourceLedger): SourceSemanticResourceBudget {
    const measured = new SourceSemanticResourceLedger(allowance);
    measured.canonicalJsonLength(value, planner);
    return { work_units: measured.spentWork, memory_bytes: measured.spentBytes };
  }
  remaining(): SourceSemanticResourceBudget { return { work_units: this.work, memory_bytes: this.bytes }; }
}

/** Schema capture copies containers, not immutable strings. This mode is only for an
 * intermediate immediately consumed by a fully charged packed retention; it must not
 * substitute for the retained capture returned by a public semantic ingress. */
function captureFrames(value: unknown, meter: Meter | undefined, phase: string): void {
  if (meter === undefined) return;
  const pending = [value];
  meter?.charge(0, 8, phase);
  while (pending.length) {
    const row = pending.pop();
    meter?.charge(1, 0, phase);
    if (row === null || typeof row !== "object") continue;
    const array = Array.isArray(row), keys = array ? undefined : Object.keys(row);
    const count = array ? row.length : keys!.length;
    // Owned container slots plus the key-reference array used by this bounded scan.
    meter?.charge(0, 64 + count * (array ? 8 : 16), phase);
    if (array) for (const child of row) pending.push(child);
    else for (const key of keys!) pending.push((row as Record<string, unknown>)[key]);
  }
}

function traverseRetained(value: unknown, meter: SourceSemanticResourceLedger, phase: string,
  planner?: SourceSemanticResourceLedger, quote = false, immutable = false, borrow = false): number {
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
    // Only a completed owner retention certifies a borrow. Frozen caller objects and
    // numeric quotes cannot assert ownership; an actual copy still pays its full price.
    if (borrow && row !== null && typeof row === "object" && IMMUTABLE_PRICES.has(row)) {
      charge(1, 8);
      continue;
    }
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
    if (immutable) freezeWork += freezeOwned(row, charge, phase);
    if (array) for (const item of row) pending.push(item);
    else for (const key of keys!) pending.push((row as Record<string, unknown>)[key]);
  }
  return freezeWork;
}
