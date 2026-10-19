import { performance } from "node:perf_hooks";
import { z } from "zod";
import { SourceSemanticNativeFactsSchema, SourceSemanticObservationFacts, type SourceSemanticNativeFacts } from "./source-semantic-provenance.js";

/** Private Node/worker metadata only; never part of an operation payload or public result. */
export const SourceSemanticObservationRequestSchema = z.object({
  max_events: z.number().int().min(0).max(2048).default(512),
  max_bytes: z.number().int().min(0).max(524288).default(262144)
}).strict();
export type SourceSemanticObservationOptions = z.input<typeof SourceSemanticObservationRequestSchema>;
export type SourceSemanticObservationRequest = z.output<typeof SourceSemanticObservationRequestSchema>;
export type ObservationCost = { phase: string; reason: string; operation: string; count: number; work: number; bytes: number };
export type ObservationMeter = { id: number; parent: number | null; phase: string;
  initial: { work_units: number; memory_bytes: number }; remaining: { work_units: number; memory_bytes: number };
  spent: { work_units: number; memory_bytes: number }; held: { work_units: number; memory_bytes: number } };
export type SourceSemanticObservation = Readonly<{
  version: 1; request_id: number;
  status: "observed" | "not_observed" | "partial" | "overflow" | "failure" | "unavailable";
  execution: "success" | "failure" | "unknown";
  events: readonly Readonly<{ kind: string; phase: string; data: unknown }>[];
  /** Absent on historical frames. Diagnostic omission does not truncate the native finite union. */
  facts?: SourceSemanticNativeFacts;
  diagnostics?: Readonly<{ status: "complete" | "overflow"; compacted_events: number; omitted_events: number;
    counts: Readonly<Record<string, number>> }>;
  costs: readonly ObservationCost[];
  meters: readonly ObservationMeter[];
  /** Null means unavailable; partial aggregates are lower bounds, not successful zero cost. */
  totals: Readonly<{ debit_work: number; debit_bytes: number; absorb_work: number; absorb_bytes: number }> | null;
  dropped_events: number; aggregates_complete: boolean;
  overhead: Readonly<{ capture_ms: number | null; event_json_bytes: number; ipc_bytes: number | null;
    ipc_time: "not_measured"; physical_peak_memory: "not_measured"; physical_sql_work: "not_measured" }>;
  issues: readonly string[];
}>;

export function unavailableSourceSemanticObservation(requestId: number, issue: string): SourceSemanticObservation {
  return { version: 1, request_id: requestId, status: "unavailable", execution: "unknown", events: [], costs: [], meters: [],
    totals: null, dropped_events: 0, aggregates_complete: false,
    overhead: { capture_ms: null, event_json_bytes: 0, ipc_bytes: null, ipc_time: "not_measured",
      physical_peak_memory: "not_measured", physical_sql_work: "not_measured" }, issues: [issue] };
}

/** Bounded detail plus independent cumulative counters. Absorption is a transfer, NOT another debit.
 * Diagnostic allocations/timing are outside the recall ledger; they are not asserted to be free. */
export class SourceSemanticObserver {
  private readonly events: { kind: string; phase: string; data: unknown }[] = [];
  private readonly costs = new Map<string, ObservationCost>();
  private readonly meters: (() => ObservationMeter)[] = [];
  private readonly issues = new Set<string>();
  private readonly totals = { debit_work: 0, debit_bytes: 0, absorb_work: 0, absorb_bytes: 0 };
  private eventBytes = 0;
  private dropped = 0;
  private captureMs = 0;
  private captureDepth = 0;
  private failed = false;
  private aggregatesComplete = true;
  private nextMeter = 1;
  readonly facts: SourceSemanticObservationFacts;
  private diagnosticBytes = 0;
  private diagnosticEvents = 0;
  private compactedDiagnostics = 0;
  private omittedDiagnostics = 0;
  private readonly diagnosticCounts: Record<string, number> = {};
  private readonly diagnosticPayloads = new Set<string>();

  constructor(private readonly requestId: number, private readonly limits: SourceSemanticObservationRequest) {
    this.facts = new SourceSemanticObservationFacts(requestId, limits.max_bytes, work => this.safely(work));
  }

  private safely(work: () => void): void {
    const start = performance.now(), outer = this.captureDepth++ === 0;
    try { work(); }
    catch { this.failed = true; this.issues.add("observer_capture_failed"); }
    finally { this.captureDepth--; if (outer) this.captureMs += performance.now() - start; }
  }

  context(runtime: object, data: () => Omit<NonNullable<SourceSemanticNativeFacts["binding"]>, "session_id" | "request_id">): void {
    this.safely(() => this.facts.begin(runtime, data()));
  }

  meter(snapshot: (id: number) => ObservationMeter): number {
    const id = this.nextMeter++;
    this.safely(() => {
      if (this.meters.length >= 32) { this.aggregatesComplete = false; this.issues.add("meter_detail_limit"); return; }
      this.meters.push(() => snapshot(id));
    });
    return id;
  }

  cost(phase: string, reason: string, operation: string, work: number, bytes: number): void {
    this.safely(() => {
      if (operation === "debit" || operation === "absorb") {
        const prefix = operation === "debit" ? "debit" : "absorb";
        this.totals[`${prefix}_work`] += work; this.totals[`${prefix}_bytes`] += bytes;
      }
      const bounded = reason.length <= 160 && phase.length <= 80;
      let key = bounded ? `${phase}\0${reason}\0${operation}` : "";
      if (!bounded || !this.costs.has(key) && this.costs.size >= 255) {
        key = `overflow\0other\0${operation}`;
        phase = "overflow"; reason = "other";
        this.issues.add("cost_reason_limit"); this.aggregatesComplete = false;
      }
      const row = this.costs.get(key) ?? { phase, reason, operation, count: 0, work: 0, bytes: 0 };
      row.count++; row.work += Number.isFinite(work) ? work : 0; row.bytes += Number.isFinite(bytes) ? bytes : 0;
      this.costs.set(key, row);
    });
  }

  event(kind: string, phase: string, data: () => unknown): void {
    this.safely(() => {
      const diagnostic = ["selection_attempt", "selection_result", "selection_failure", "encoding_attempt", "encoding_result"].includes(kind);
      if (diagnostic) this.diagnosticCounts[kind] = (this.diagnosticCounts[kind] ?? 0) + 1;
      // Repeated fit/encoding detail must not eclipse source reads, union membership and final visibility.
      // Independent operation aggregates continue even when diagnostic detail is omitted.
      const omit = () => { if (diagnostic) this.omittedDiagnostics++; else this.dropped++; };
      if (this.events.length >= this.limits.max_events || this.eventBytes >= this.limits.max_bytes
        || diagnostic && (this.diagnosticEvents >= Math.floor(this.limits.max_events / 4)
          || this.diagnosticBytes >= Math.floor(this.limits.max_bytes / 4))) { omit(); return; }
      const value = { kind, phase, data: data() };
      // Bound temporary serialization too. Oversize identities/trees are unknown, never silently clipped.
      const pending: unknown[] = [value];
      let nodes = 0, characters = 0;
      while (pending.length > 0) {
        const item = pending.pop();
        if (++nodes > 8192) { omit(); return; }
        if (typeof item === "string") characters += item.length;
        else if (item !== null && typeof item === "object") {
          const keys = Object.keys(item);
          if (keys.length + pending.length > 8192) { omit(); return; }
          for (const key of keys) { characters += key.length; pending.push((item as Record<string, unknown>)[key]); }
        }
        if (characters > this.limits.max_bytes) { omit(); return; }
      }
      const json = JSON.stringify(value);
      const size = Buffer.byteLength(json);
      if (diagnostic && this.diagnosticPayloads.has(json)) { this.compactedDiagnostics++; return; }
      if (size > this.limits.max_bytes - this.eventBytes || diagnostic && size > Math.floor(this.limits.max_bytes / 4) - this.diagnosticBytes) {
        omit(); return;
      }
      // Snapshot metadata, never retain mutable producer objects or source bodies.
      this.events.push(JSON.parse(json) as { kind: string; phase: string; data: unknown });
      this.eventBytes += size;
      if (diagnostic) { this.diagnosticPayloads.add(json); this.diagnosticEvents++; this.diagnosticBytes += size; }
    });
  }

  finish(execution: "success" | "failure"): SourceSemanticObservation {
    const snapshots: ObservationMeter[] = [];
    this.safely(() => { for (const snapshot of this.meters) snapshots.push(snapshot()); });
    const status = this.failed ? "failure" : this.dropped > 0 || !this.aggregatesComplete ? "overflow" : execution === "failure"
      ? "partial" : this.meters.length === 0 ? "not_observed" : "observed";
    const result: SourceSemanticObservation = { version: 1, request_id: this.requestId, status, execution,
      events: this.events, costs: [...this.costs.values()], meters: snapshots, totals: { ...this.totals },
      facts: this.facts.finish(), diagnostics: { status: this.omittedDiagnostics > 0 ? "overflow" : "complete",
        compacted_events: this.compactedDiagnostics, omitted_events: this.omittedDiagnostics, counts: { ...this.diagnosticCounts } },
      dropped_events: this.dropped, aggregates_complete: this.aggregatesComplete && !this.failed,
      overhead: { capture_ms: this.captureMs, event_json_bytes: this.eventBytes, ipc_bytes: null,
        ipc_time: "not_measured", physical_peak_memory: "not_measured", physical_sql_work: "not_measured" },
      issues: [...this.issues] };
    // JSON is a bounded metadata proxy, not a measurement of V8 structured-clone IPC bytes.
    try {
      if (Buffer.byteLength(JSON.stringify(result)) <= 1_000_000) return result;
    } catch { /* Diagnostic serialization failure must not reject the operation. */ }
    return { ...unavailableSourceSemanticObservation(this.requestId, "observer_finalization_failed"), status: "failure", execution };
  }
}

const Nonnegative = z.number().finite().nonnegative();
const CounterBudget = z.object({ work_units: Nonnegative, memory_bytes: Nonnegative }).strict();
const ObservationSchema: z.ZodType<SourceSemanticObservation> = z.object({
  version: z.literal(1), request_id: z.number().finite(),
  status: z.enum(["observed", "not_observed", "partial", "overflow", "failure", "unavailable"]),
  execution: z.enum(["success", "failure", "unknown"]),
  events: z.array(z.object({ kind: z.string().max(80), phase: z.string().max(80), data: z.unknown() }).strict()).max(2048),
  facts: SourceSemanticNativeFactsSchema.optional(),
  diagnostics: z.object({ status: z.enum(["complete", "overflow"]), compacted_events: Nonnegative,
    omitted_events: Nonnegative, counts: z.record(z.string().max(80), Nonnegative) }).strict().optional(),
  costs: z.array(z.object({ phase: z.string().max(80), reason: z.string().max(160), operation: z.string().max(32),
    count: Nonnegative, work: Nonnegative, bytes: Nonnegative }).strict()).max(270),
  meters: z.array(z.object({ id: Nonnegative, parent: Nonnegative.nullable(), phase: z.string().max(80),
    initial: CounterBudget, remaining: CounterBudget, spent: CounterBudget, held: CounterBudget }).strict()).max(32),
  totals: z.object({ debit_work: Nonnegative, debit_bytes: Nonnegative, absorb_work: Nonnegative, absorb_bytes: Nonnegative }).strict().nullable(),
  dropped_events: Nonnegative, aggregates_complete: z.boolean(),
  overhead: z.object({ capture_ms: Nonnegative.nullable(), event_json_bytes: Nonnegative, ipc_bytes: Nonnegative.nullable(),
    ipc_time: z.literal("not_measured"), physical_peak_memory: z.literal("not_measured"), physical_sql_work: z.literal("not_measured") }).strict(),
  issues: z.array(z.string().max(160)).max(16)
}).strict();

/** Validate diagnostic metadata separately: malformed observations cannot reject a valid operation result. */
export function readSourceSemanticObservation(value: unknown, requestId: number): SourceSemanticObservation {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined && Buffer.byteLength(json) <= 1_000_000) {
      const parsed = ObservationSchema.safeParse(JSON.parse(json));
      if (parsed.success && parsed.data.request_id === requestId) return parsed.data;
    }
  } catch { /* Invalid diagnostics remain unavailable, independently of the operation. */ }
  return unavailableSourceSemanticObservation(requestId, "missing_or_invalid_worker_observation");
}
