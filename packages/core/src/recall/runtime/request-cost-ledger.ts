import { performance } from "node:perf_hooks";
import type { RetainedFieldLevels } from "./request-cost-engine-snapshot.js";

export const REQUEST_COST_PHASES = [
  "compile",
  "observe",
  "seed",
  "adjacency",
  "measurement",
  "solve",
  "index",
  "payload"
] as const;

export type RequestCostPhase = (typeof REQUEST_COST_PHASES)[number];

export const RSS_SAMPLE_METHOD = "process.memoryUsage().rss" as const;

export type RequestCostDelta = Readonly<{
  readonly native_visits?: number;
  readonly native_rows?: number;
  readonly native_bytes?: number;
  readonly charged_retained_bytes?: number;
  readonly joins?: number;
  readonly relaxations?: number;
  readonly state_creates?: number;
  // Remaining worklist units, not executed work.
  readonly pending_work?: number;
  readonly cache_hits?: number;
  readonly cache_misses?: number;
}>;

export type RequestPhaseCost = Readonly<{
  readonly exclusive_ms: number;
  readonly inclusive_ms: number;
  readonly native_visits: number;
  readonly native_rows: number;
  readonly native_bytes: number;
  readonly charged_retained_bytes: number;
  readonly joins: number;
  readonly relaxations: number;
  readonly state_creates: number;
  readonly pending_work: number;
  readonly cache_hits: number;
  readonly cache_misses: number;
}>;

export type RequestActualCost = Readonly<{
  readonly native_visits: number;
  readonly native_rows: number;
  readonly native_bytes: number;
  readonly charged_retained_bytes: number;
  // Retained cardinality/bytes are levels; they must not roll into phase work sums.
  readonly retained_states_current: number;
  readonly retained_bytes_current: number;
  readonly phases: Readonly<Record<RequestCostPhase, RequestPhaseCost>>;
  readonly rss: Readonly<{
    readonly method: typeof RSS_SAMPLE_METHOD;
    readonly start_bytes: number;
    readonly after_projection_bytes: number;
    readonly peak_bytes: number;
  }>;
}>;

// Inclusive timing nests children; visits/bytes stay exclusive to the emitting phase.
const NESTED_PHASES: Readonly<Partial<Record<RequestCostPhase, readonly RequestCostPhase[]>>> = {
  observe: ["seed", "adjacency", "measurement"],
  index: ["solve", "payload"]
};

type MutablePhase = {
  inclusive_ms: number;
  native_visits: number;
  native_rows: number;
  native_bytes: number;
  charged_retained_bytes: number;
  joins: number;
  relaxations: number;
  state_creates: number;
  pending_work: number;
  cache_hits: number;
  cache_misses: number;
};

function emptyPhase(): MutablePhase {
  return {
    inclusive_ms: 0,
    native_visits: 0,
    native_rows: 0,
    native_bytes: 0,
    charged_retained_bytes: 0,
    joins: 0,
    relaxations: 0,
    state_creates: 0,
    pending_work: 0,
    cache_hits: 0,
    cache_misses: 0
  };
}

export class RequestCostLedger {
  private readonly startRss: number;
  private afterProjectionRss: number | undefined;
  private peakRss: number;
  private retainedStatesCurrent = 0;
  private retainedBytesCurrent = 0;
  private readonly phases = Object.fromEntries(
    REQUEST_COST_PHASES.map((phase) => [phase, emptyPhase()])
  ) as Record<RequestCostPhase, MutablePhase>;

  public constructor() {
    this.startRss = process.memoryUsage().rss;
    this.peakRss = this.startRss;
  }

  public time<T>(phase: RequestCostPhase, run: () => T): T {
    const started = performance.now();
    try {
      return run();
    } finally {
      this.phases[phase].inclusive_ms += performance.now() - started;
    }
  }

  public add(phase: RequestCostPhase, delta: RequestCostDelta): void {
    const row = this.phases[phase];
    row.native_visits += delta.native_visits ?? 0;
    row.native_rows += delta.native_rows ?? 0;
    row.native_bytes += delta.native_bytes ?? 0;
    row.charged_retained_bytes += delta.charged_retained_bytes ?? 0;
    row.joins += delta.joins ?? 0;
    row.relaxations += delta.relaxations ?? 0;
    row.state_creates += delta.state_creates ?? 0;
    row.pending_work += delta.pending_work ?? 0;
    row.cache_hits += delta.cache_hits ?? 0;
    row.cache_misses += delta.cache_misses ?? 0;
  }

  public markAfterProjection(): void {
    this.afterProjectionRss = this.sampleRss();
  }

  public recordRetainedLevels(levels: RetainedFieldLevels): void {
    this.retainedStatesCurrent = levels.retained_states_current;
    this.retainedBytesCurrent = levels.retained_bytes_current;
    this.sampleRss();
  }

  public snapshot(): RequestActualCost {
    const phases = {} as Record<RequestCostPhase, RequestPhaseCost>;
    let native_visits = 0;
    let native_rows = 0;
    let native_bytes = 0;
    let charged_retained_bytes = 0;
    for (const phase of REQUEST_COST_PHASES) {
      const row = this.phases[phase];
      const nested = (NESTED_PHASES[phase] ?? []).reduce(
        (sum, child) => sum + this.phases[child].inclusive_ms,
        0
      );
      phases[phase] = {
        exclusive_ms: Math.max(0, row.inclusive_ms - nested),
        inclusive_ms: row.inclusive_ms,
        native_visits: row.native_visits,
        native_rows: row.native_rows,
        native_bytes: row.native_bytes,
        charged_retained_bytes: row.charged_retained_bytes,
        joins: row.joins,
        relaxations: row.relaxations,
        state_creates: row.state_creates,
        pending_work: row.pending_work,
        cache_hits: row.cache_hits,
        cache_misses: row.cache_misses
      };
      native_visits += row.native_visits;
      native_rows += row.native_rows;
      native_bytes += row.native_bytes;
      charged_retained_bytes += row.charged_retained_bytes;
    }
    const afterProjection = this.afterProjectionRss ?? this.sampleRss();
    return {
      native_visits,
      native_rows,
      native_bytes,
      charged_retained_bytes,
      retained_states_current: this.retainedStatesCurrent,
      retained_bytes_current: this.retainedBytesCurrent,
      phases,
      rss: {
        method: RSS_SAMPLE_METHOD,
        start_bytes: this.startRss,
        after_projection_bytes: afterProjection,
        peak_bytes: Math.max(this.peakRss, afterProjection, this.startRss)
      }
    };
  }

  private sampleRss(): number {
    const rss = process.memoryUsage().rss;
    this.peakRss = Math.max(this.peakRss, rss);
    return rss;
  }
}

export function startRequestCost(): RequestCostLedger {
  return new RequestCostLedger();
}
