import { CoreError } from "../../shared/errors.js";

export const RECALL_RETENTION_TTL_MS = 5 * 60_000;
type Retained = Readonly<{ execution: string; workspace: string; bytes: number;
  handles: readonly string[]; value: unknown; deadline?: number }>;
export type RecallRetentionRemoval = Readonly<{ handles: readonly string[];
  reason: "expired" | "discarded" | "invalidated" }>;

/** Process-local execution leases. Capacity refusal never evicts another valid
 * execution. Shared immutable nodes are conservatively charged per retained root. */
export class RecallExecutionRetention {
  private readonly records = new Map<string, Retained>();
  private readonly deadlines = new Map<string, number>();
  private readonly listeners = new Set<(event: RecallRetentionRemoval) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private bytes = 0;
  private transactionEvents: RecallRetentionRemoval[] | undefined;

  constructor(private readonly capacity = 128 * 1024 * 1024,
    private readonly workspaceCapacity = 64 * 1024 * 1024,
    private readonly ttl = RECALL_RETENTION_TTL_MS) {}

  get<T>(key: string): T | undefined { this.sweep(); return this.records.get(key)?.value as T | undefined; }
  values<T>(prefix: string): readonly T[] {
    this.sweep();
    return [...this.records].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row.value as T);
  }
  executionFor(handle: string): string | undefined {
    this.sweep();
    for (const row of this.records.values()) if (row.handles.includes(handle)) return row.execution;
    return undefined;
  }
  workspaceFor(execution: string): string {
    for (const row of this.records.values()) if (row.execution === execution) return row.workspace;
    return "";
  }
  transaction<T>(work: () => T): T {
    this.sweep();
    if (this.transactionEvents !== undefined) return work();
    const records = new Map(this.records);
    const deadlines = new Map(this.deadlines);
    const bytes = this.bytes;
    this.transactionEvents = [];
    let result: T;
    let events: RecallRetentionRemoval[];
    try {
      result = work();
      events = this.transactionEvents;
    } catch (error) {
      this.records.clear();
      for (const [key, row] of records) this.records.set(key, row);
      this.deadlines.clear();
      for (const [key, deadline] of deadlines) this.deadlines.set(key, deadline);
      this.bytes = bytes;
      throw error;
    } finally { this.transactionEvents = undefined; this.schedule(); }
    // Publication follows the committed state; observer failure cannot roll it back.
    for (const event of events) this.notify(event);
    return result;
  }
  set(key: string, row: Retained): void {
    this.sweep();
    const previous = this.records.get(key);
    const bytes = Math.ceil(row.bytes) + 256 + key.length * 2 + row.handles.reduce((sum, id) => sum + 64 + id.length * 2, 0);
    let workspaceBytes = 0;
    for (const [id, retained] of this.records) {
      if (id !== key && retained.workspace === row.workspace) workspaceBytes += retained.bytes;
    }
    if (!Number.isFinite(row.bytes) || row.bytes < 0 || this.bytes - (previous?.bytes ?? 0) + bytes > this.capacity
      || workspaceBytes + bytes > this.workspaceCapacity) {
      throw new CoreError("CONFLICT", "Recall execution retention capacity exhausted", {
        details: { outcome: "resource_exhausted", resource: "execution_retention", required_bytes: bytes,
          retained_bytes: this.bytes, capacity_bytes: this.capacity, workspace_capacity_bytes: this.workspaceCapacity }
      });
    }
    this.records.set(key, { ...row, bytes });
    this.bytes += bytes - (previous?.bytes ?? 0);
    this.deadlines.set(row.execution, Math.min(this.deadlines.get(row.execution) ?? Date.now() + this.ttl,
      row.deadline ?? Number.POSITIVE_INFINITY));
    this.schedule();
  }
  delete(key: string, reason: RecallRetentionRemoval["reason"] = "discarded"): void {
    const row = this.records.get(key);
    if (row === undefined) return;
    this.records.delete(key);
    this.bytes -= row.bytes;
    const remaining = [...this.records.values()];
    if (!remaining.some(value => value.execution === row.execution)) this.deadlines.delete(row.execution);
    const handles = row.handles.filter(handle => !remaining.some(value => value.handles.includes(handle)));
    if (handles.length > 0) {
      const event = { handles, reason };
      if (this.transactionEvents !== undefined) this.transactionEvents.push(event);
      else this.notify(event);
    }
    this.schedule();
  }
  invalidate(execution: string, reason: RecallRetentionRemoval["reason"] = "invalidated"): void {
    for (const [key, row] of this.records) if (row.execution === execution) this.delete(key, reason);
  }
  subscribe(listener: (event: RecallRetentionRemoval) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  snapshot(): Readonly<{ entries: number; executions: number; retained_bytes: number }> {
    this.sweep();
    return { entries: this.records.size, executions: this.deadlines.size, retained_bytes: this.bytes };
  }
  private sweep(): void {
    for (const [execution, deadline] of this.deadlines) {
      if (deadline <= Date.now()) this.invalidate(execution, "expired");
    }
  }
  private notify(event: RecallRetentionRemoval): void {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { process.emitWarning(`Recall retention notification failed: ${String(error)}`); }
    }
  }
  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.deadlines.size === 0) return;
    let deadline = Number.POSITIVE_INFINITY;
    for (const value of this.deadlines.values()) deadline = Math.min(deadline, value);
    this.timer = setTimeout(() => { this.timer = undefined; this.sweep(); this.schedule(); },
      Math.max(1, deadline - Date.now()));
    this.timer.unref?.();
  }
}

/** Conservative JS retention quote, including Maps/Sets and UTF-16 strings.
 * Cycles/shared nodes within one root are counted once; independent roots pay
 * separately. Stop at the process limit rather than traversing an oversized graph. */
export function recallRetentionBytes(root: unknown): number {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  let bytes = 0;
  while (pending.length > 0 && bytes <= 128 * 1024 * 1024) {
    const value = pending.pop();
    if (typeof value === "string") { bytes += 32 + value.length * 2; continue; }
    if (value === null || typeof value !== "object") { bytes += 16; continue; }
    if (seen.has(value)) continue;
    seen.add(value);
    bytes += 128;
    if (ArrayBuffer.isView(value)) { pending.push(value.buffer); continue; }
    if (value instanceof ArrayBuffer) { bytes += value.byteLength; continue; }
    if (value instanceof Map) {
      bytes += value.size * 64;
      for (const [key, item] of value) pending.push(key, item);
    } else if (value instanceof Set) {
      bytes += value.size * 48;
      for (const item of value) pending.push(item);
    } else {
      for (const [key, item] of Object.entries(value)) { bytes += 32 + key.length * 2; pending.push(item); }
    }
  }
  return bytes;
}

export const recallExecutionRetention = new RecallExecutionRetention();
