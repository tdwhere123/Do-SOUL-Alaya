import { z } from "zod";

// Pure aggregation helper for recall-utilization 5-bucket counts.
// Consumers: bench cohort metric (this module) and the daemon route at
// apps/core-daemon/src/routes/recall-utilization.ts (which derives the
// same buckets directly from EventLog payloads).
//
// invariant: pure function over already-projected events; does not touch
// trust state, PathRelation, or any storage. Counts only.

export const UtilizationBucketDeliverySchema = z
  .object({
    delivery_id: z.string().min(1),
    session_id: z.string().min(1),
    run_id: z.string().min(1).nullable(),
    agent_target: z.string().min(1),
    pointer_count: z.number().int().nonnegative(),
    // Optional: present on cohort-rollup inputs; scopes the delivery_id so the
    // same id across workspaces does not cross-match.
    workspace_id: z.string().min(1).optional()
  })
  .readonly();

export const UtilizationBucketReportSchema = z
  .object({
    delivery_id: z.string().min(1),
    session_id: z.string().min(1),
    run_id: z.string().min(1).nullable(),
    agent_target: z.string().min(1),
    usage_state: z.enum(["used", "skipped", "not_applicable"]),
    turn_index: z.number().int().nonnegative().optional(),
    // Optional: see UtilizationBucketDeliverySchema.workspace_id.
    workspace_id: z.string().min(1).optional()
  })
  .readonly();

export type UtilizationBucketDelivery = z.infer<typeof UtilizationBucketDeliverySchema>;
export type UtilizationBucketReport = z.infer<typeof UtilizationBucketReportSchema>;

export interface UtilizationBucketCounts {
  readonly no_recall: number;
  readonly empty_recall: number;
  readonly delivered_not_reported: number;
  readonly reported_skipped_or_na: number;
  readonly reported_used: number;
}

export interface UtilizationBucketCohortRow {
  readonly workspace_id: string;
  readonly agent_target: string;
  readonly buckets: UtilizationBucketCounts;
  readonly delivery_total: number;
}

// Compute the 5-bucket split for a single (workspace, agent_target) cohort.
//
// invariant (matches the daemon route):
//   delivered_not_reported + reported_skipped_or_na + reported_used === deliveries.length
// empty_recall is a sub-count carved out of delivered_not_reported (pointer_count === 0
// deliveries have nothing to report by construction).
//
// no_recall counts distinct session_id values whose reports reference a
// delivery_id that has no matching SOUL_RECALL_DELIVERED in the window;
// i.e., the agent attached but did not call recall in those sessions.
// see also: apps/core-daemon/src/routes/recall-utilization.ts
// computeBuckets (must stay in lockstep on this denominator).
export function computeUtilizationBuckets(input: {
  readonly deliveries: readonly UtilizationBucketDelivery[];
  readonly reports: readonly UtilizationBucketReport[];
}): UtilizationBucketCounts {
  const deliveryByKey = new Map<string, UtilizationBucketDelivery>();
  for (const delivery of input.deliveries) {
    deliveryByKey.set(deliveryKey(delivery.workspace_id, delivery.delivery_id), delivery);
  }

  // Collapse retries per (workspace_id, delivery_id) by max-state precedence so
  // one "used" anywhere in the window counts the delivery as used.
  const reportStateByKey = new Map<string, "used" | "skipped" | "not_applicable">();
  for (const report of input.reports) {
    const key = deliveryKey(report.workspace_id, report.delivery_id);
    const existing = reportStateByKey.get(key);
    if (existing === undefined) {
      reportStateByKey.set(key, report.usage_state);
      continue;
    }
    reportStateByKey.set(key, mergeUsageState(existing, report.usage_state));
  }

  let emptyRecall = 0;
  let deliveredNotReported = 0;
  let reportedSkippedOrNa = 0;
  let reportedUsed = 0;

  for (const delivery of input.deliveries) {
    const reportState = reportStateByKey.get(deliveryKey(delivery.workspace_id, delivery.delivery_id));
    if (reportState === undefined) {
      deliveredNotReported += 1;
      if (delivery.pointer_count === 0) {
        emptyRecall += 1;
      }
      continue;
    }
    if (reportState === "used") {
      reportedUsed += 1;
    } else {
      reportedSkippedOrNa += 1;
    }
  }

  const orphanSessions = new Set<string>();
  for (const report of input.reports) {
    if (deliveryByKey.has(deliveryKey(report.workspace_id, report.delivery_id))) continue;
    orphanSessions.add(report.session_id);
  }

  return Object.freeze({
    no_recall: orphanSessions.size,
    empty_recall: emptyRecall,
    delivered_not_reported: deliveredNotReported,
    reported_skipped_or_na: reportedSkippedOrNa,
    reported_used: reportedUsed
  });
}

// Group deliveries + reports by (workspace_id, agent_target) and emit one
// cohort row per group. Both inputs must already be filtered to the time
// window of interest; this helper does not enforce a window.
export function rollUpUtilizationBucketsByCohort(input: {
  readonly deliveries: readonly (UtilizationBucketDelivery & { readonly workspace_id: string })[];
  readonly reports: readonly (UtilizationBucketReport & { readonly workspace_id: string })[];
}): readonly UtilizationBucketCohortRow[] {
  const cohortKey = (workspaceId: string, agentTarget: string): string =>
    JSON.stringify([workspaceId, agentTarget]);

  const grouped = new Map<
    string,
    {
      readonly workspace_id: string;
      readonly agent_target: string;
      readonly deliveries: UtilizationBucketDelivery[];
      readonly reports: UtilizationBucketReport[];
    }
  >();

  const ensureCohort = (workspaceId: string, agentTarget: string) => {
    const key = cohortKey(workspaceId, agentTarget);
    const existing = grouped.get(key);
    if (existing !== undefined) return existing;
    const created = {
      workspace_id: workspaceId,
      agent_target: agentTarget,
      deliveries: [] as UtilizationBucketDelivery[],
      reports: [] as UtilizationBucketReport[]
    };
    grouped.set(key, created);
    return created;
  };

  for (const delivery of input.deliveries) {
    ensureCohort(delivery.workspace_id, delivery.agent_target).deliveries.push(delivery);
  }
  for (const report of input.reports) {
    ensureCohort(report.workspace_id, report.agent_target).reports.push(report);
  }

  const rows: UtilizationBucketCohortRow[] = [];
  for (const cohort of grouped.values()) {
    rows.push({
      workspace_id: cohort.workspace_id,
      agent_target: cohort.agent_target,
      buckets: computeUtilizationBuckets({
        deliveries: cohort.deliveries,
        reports: cohort.reports
      }),
      delivery_total: cohort.deliveries.length
    });
  }
  rows.sort((a, b) => {
    const cmp = a.workspace_id.localeCompare(b.workspace_id);
    return cmp === 0 ? a.agent_target.localeCompare(b.agent_target) : cmp;
  });
  return Object.freeze(rows);
}

// Detect deliveries that the route would tag as `single_used_anchor`:
// a delivery with pointer_count === 1 whose report state is "used". These
// rows feed the SOUL_SINGLE_USED_ANCHOR telemetry event the daemon route
// emits per match.
export function listSingleUsedAnchorDeliveries(input: {
  readonly deliveries: readonly UtilizationBucketDelivery[];
  readonly reports: readonly UtilizationBucketReport[];
}): readonly UtilizationBucketDelivery[] {
  const usedReportIds = new Set<string>();
  for (const report of input.reports) {
    if (report.usage_state === "used") {
      usedReportIds.add(report.delivery_id);
    }
  }
  return Object.freeze(
    input.deliveries.filter(
      (delivery) => delivery.pointer_count === 1 && usedReportIds.has(delivery.delivery_id)
    )
  );
}

// (workspace_id, delivery_id) composite so the same delivery_id across
// workspaces does not cross-match. Mirrors rollUpUtilizationBucketsByCohort's
// cohortKey. A missing workspace_id collapses to single-scope (pre-fix) behavior.
function deliveryKey(workspaceId: string | undefined, deliveryId: string): string {
  return JSON.stringify([workspaceId ?? "", deliveryId]);
}

function mergeUsageState(
  a: "used" | "skipped" | "not_applicable",
  b: "used" | "skipped" | "not_applicable"
): "used" | "skipped" | "not_applicable" {
  if (a === "used" || b === "used") return "used";
  if (a === "skipped" || b === "skipped") return "skipped";
  return "not_applicable";
}
