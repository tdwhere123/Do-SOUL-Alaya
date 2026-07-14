/**
 * Bounded review/re-drive working set for garden source-grounding deferrals.
 * Fail-closed materialization stays closed; this queue makes loss operator-visible
 * and re-driveable. Rows are governance metadata only (invariant §14) — never
 * durable memory objects.
 *
 * Cap is storage-budget-derived (~200B metadata/row → ~400KB at 2048), not a
 * recall-quality tuning knob.
 */
export const SOURCE_GROUNDING_DEFER_QUEUE_CAP = 2048;

export type SourceGroundingDeferClass = "source_grounding";

export interface SourceGroundingDeferEntry {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly defer_reason: string;
  readonly enqueued_at: string;
}

export interface SourceGroundingDeferEnqueueResult {
  readonly entry: SourceGroundingDeferEntry;
  /** Oldest entry removed when the FIFO cap was enforced; null if under cap. */
  readonly evicted: SourceGroundingDeferEntry | null;
}

export interface SourceGroundingDeferStats {
  readonly queue_depth: number;
  readonly queue_cap: number;
  /** Lifetime enqueues by defer_reason (not decremented on dequeue/evict). */
  readonly deferred_by_reason: Readonly<Record<string, number>>;
}

export interface SourceGroundingDeferQueuePort {
  enqueue(input: {
    readonly signal_id: string;
    readonly workspace_id: string;
    readonly run_id: string;
    readonly defer_reason: string;
    readonly enqueued_at?: string;
  }): SourceGroundingDeferEnqueueResult;
  remove(signalId: string): boolean;
  get(signalId: string): SourceGroundingDeferEntry | null;
  list(limit?: number): readonly SourceGroundingDeferEntry[];
  stats(): SourceGroundingDeferStats;
}

export function createInMemorySourceGroundingDeferQueue(
  cap = SOURCE_GROUNDING_DEFER_QUEUE_CAP
): SourceGroundingDeferQueuePort {
  const byId = new Map<string, SourceGroundingDeferEntry>();
  const order: string[] = [];
  const lifetimeByReason = new Map<string, number>();

  return {
    enqueue(input) {
      return enqueueInMemoryDefer({ byId, order, lifetimeByReason, cap, input });
    },
    remove(signalId) {
      if (!byId.delete(signalId)) return false;
      const index = order.indexOf(signalId);
      if (index >= 0) order.splice(index, 1);
      return true;
    },
    get(signalId) {
      return byId.get(signalId) ?? null;
    },
    list(limit = cap) {
      const ids = order.slice(0, Math.max(0, limit));
      return ids.map((id) => byId.get(id)!).filter(Boolean);
    },
    stats() {
      const deferred_by_reason: Record<string, number> = {};
      for (const [reason, count] of lifetimeByReason) {
        deferred_by_reason[reason] = count;
      }
      return {
        queue_depth: order.length,
        queue_cap: cap,
        deferred_by_reason
      };
    }
  };
}

function enqueueInMemoryDefer(params: {
  readonly byId: Map<string, SourceGroundingDeferEntry>;
  readonly order: string[];
  readonly lifetimeByReason: Map<string, number>;
  readonly cap: number;
  readonly input: {
    readonly signal_id: string;
    readonly workspace_id: string;
    readonly run_id: string;
    readonly defer_reason: string;
    readonly enqueued_at?: string;
  };
}): SourceGroundingDeferEnqueueResult {
  const entry: SourceGroundingDeferEntry = {
    signal_id: params.input.signal_id,
    workspace_id: params.input.workspace_id,
    run_id: params.input.run_id,
    defer_reason: params.input.defer_reason,
    enqueued_at: params.input.enqueued_at ?? new Date().toISOString()
  };
  params.lifetimeByReason.set(
    entry.defer_reason,
    (params.lifetimeByReason.get(entry.defer_reason) ?? 0) + 1
  );

  const existingIndex = params.order.indexOf(entry.signal_id);
  if (existingIndex >= 0) {
    params.order.splice(existingIndex, 1);
    params.byId.set(entry.signal_id, entry);
    params.order.push(entry.signal_id);
    return { entry, evicted: null };
  }

  let evicted: SourceGroundingDeferEntry | null = null;
  if (params.order.length >= params.cap) {
    const oldestId = params.order.shift();
    if (oldestId !== undefined) {
      evicted = params.byId.get(oldestId) ?? null;
      params.byId.delete(oldestId);
    }
  }
  params.byId.set(entry.signal_id, entry);
  params.order.push(entry.signal_id);
  return { entry, evicted };
}

export function readSourceGroundingDeferMeta(materialization: {
  readonly routing_reason: string;
  readonly defer_reason?: string;
  readonly defer_class?: string;
}): { readonly defer_reason: string; readonly defer_class: SourceGroundingDeferClass } | null {
  if (materialization.defer_class === "source_grounding" && materialization.defer_reason) {
    return {
      defer_reason: materialization.defer_reason,
      defer_class: "source_grounding"
    };
  }
  const match = /^garden source grounding failed: (.+)$/u.exec(materialization.routing_reason);
  if (match?.[1]) {
    return { defer_reason: match[1], defer_class: "source_grounding" };
  }
  return null;
}
