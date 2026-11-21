// Pure 5-bucket recall utilization aggregation for daemon cohort reporting.
// Keeps apps/core-daemon decoupled from the offline @do-soul/alaya-eval package.

export interface UtilizationBucketDelivery {
  readonly delivery_id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly agent_target: string;
  readonly pointer_count: number;
  readonly workspace_id: string;
}

export interface UtilizationBucketReport {
  readonly delivery_id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly agent_target: string;
  readonly usage_state: "used" | "skipped" | "not_applicable";
  readonly workspace_id: string;
}

export interface UtilizationBucketCounts {
  readonly no_recall: number;
  readonly orphan_report_count: number;
  readonly orphan_session_count: number;
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
  readonly single_used_anchor_count: number;
}

type UsageState = UtilizationBucketReport["usage_state"];

interface CohortGroup {
  readonly workspace_id: string;
  readonly agent_target: string;
  readonly deliveries: UtilizationBucketDelivery[];
  readonly reports: UtilizationBucketReport[];
}

export function rollUpUtilizationBucketsByCohort(input: {
  readonly deliveries: readonly UtilizationBucketDelivery[];
  readonly reports: readonly UtilizationBucketReport[];
}): readonly UtilizationBucketCohortRow[] {
  const grouped = groupCohortRows(input.deliveries, input.reports);
  const rows: UtilizationBucketCohortRow[] = [];
  for (const cohort of grouped.values()) {
    rows.push({
      workspace_id: cohort.workspace_id,
      agent_target: cohort.agent_target,
      buckets: computeUtilizationBuckets(cohort.deliveries, cohort.reports),
      delivery_total: cohort.deliveries.length,
      single_used_anchor_count: countSingleUsedAnchorDeliveries(cohort.deliveries, cohort.reports)
    });
  }
  rows.sort((a, b) => {
    const cmp = a.workspace_id.localeCompare(b.workspace_id);
    return cmp === 0 ? a.agent_target.localeCompare(b.agent_target) : cmp;
  });
  return Object.freeze(rows);
}

function groupCohortRows(
  deliveries: readonly UtilizationBucketDelivery[],
  reports: readonly UtilizationBucketReport[]
): Map<string, CohortGroup> {
  const grouped = new Map<string, CohortGroup>();
  const ensureCohort = (workspaceId: string, agentTarget: string): CohortGroup => {
    const key = JSON.stringify([workspaceId, agentTarget]);
    const existing = grouped.get(key);
    if (existing !== undefined) return existing;
    const created: CohortGroup = {
      workspace_id: workspaceId,
      agent_target: agentTarget,
      deliveries: [],
      reports: []
    };
    grouped.set(key, created);
    return created;
  };
  for (const delivery of deliveries) {
    ensureCohort(delivery.workspace_id, delivery.agent_target).deliveries.push(delivery);
  }
  for (const report of reports) {
    ensureCohort(report.workspace_id, report.agent_target).reports.push(report);
  }
  return grouped;
}

function computeUtilizationBuckets(
  deliveries: readonly UtilizationBucketDelivery[],
  reports: readonly UtilizationBucketReport[]
): UtilizationBucketCounts {
  const deliveryByKey = new Map<string, UtilizationBucketDelivery>();
  for (const delivery of deliveries) {
    deliveryByKey.set(deliveryKey(delivery.workspace_id, delivery.delivery_id), delivery);
  }
  const reportStateByKey = indexReportsByDelivery(reports);
  const deliveryCounts = tallyDeliveryBuckets(deliveries, reportStateByKey);
  const orphanCounts = countOrphanReports(deliveries, deliveryByKey, reports);

  return Object.freeze({
    ...orphanCounts,
    ...deliveryCounts
  });
}

function indexReportsByDelivery(reports: readonly UtilizationBucketReport[]): Map<string, UsageState> {
  // Collapse retries per (workspace_id, delivery_id) by max-state precedence.
  const reportStateByKey = new Map<string, UsageState>();
  for (const report of reports) {
    const key = deliveryKey(report.workspace_id, report.delivery_id);
    const existing = reportStateByKey.get(key);
    reportStateByKey.set(key, existing === undefined ? report.usage_state : mergeUsageState(existing, report.usage_state));
  }
  return reportStateByKey;
}

function tallyDeliveryBuckets(
  deliveries: readonly UtilizationBucketDelivery[],
  reportStateByKey: ReadonlyMap<string, UsageState>
) {
  let emptyRecall = 0;
  let deliveredNotReported = 0;
  let reportedSkippedOrNa = 0;
  let reportedUsed = 0;

  for (const delivery of deliveries) {
    const reportState = reportStateByKey.get(deliveryKey(delivery.workspace_id, delivery.delivery_id));
    if (reportState === undefined) {
      deliveredNotReported += 1;
      if (delivery.pointer_count === 0) emptyRecall += 1;
      continue;
    }
    if (reportState === "used") {
      reportedUsed += 1;
    } else {
      reportedSkippedOrNa += 1;
    }
  }

  return {
    empty_recall: emptyRecall,
    delivered_not_reported: deliveredNotReported,
    reported_skipped_or_na: reportedSkippedOrNa,
    reported_used: reportedUsed
  };
}

function countOrphanReports(
  deliveries: readonly UtilizationBucketDelivery[],
  deliveryByKey: ReadonlyMap<string, UtilizationBucketDelivery>,
  reports: readonly UtilizationBucketReport[]
) {
  const orphanSessions = new Set<string>();
  const deliverySessions = new Set(deliveries.map(sessionKey));
  let orphanReportCount = 0;
  for (const report of reports) {
    if (deliveryByKey.has(deliveryKey(report.workspace_id, report.delivery_id))) continue;
    orphanReportCount += 1;
    orphanSessions.add(sessionKey(report));
  }
  return {
    no_recall: [...orphanSessions].filter((session) => !deliverySessions.has(session)).length,
    orphan_report_count: orphanReportCount,
    orphan_session_count: orphanSessions.size
  };
}

function countSingleUsedAnchorDeliveries(
  deliveries: readonly UtilizationBucketDelivery[],
  reports: readonly UtilizationBucketReport[]
): number {
  const usedReportIds = new Set<string>();
  for (const report of reports) {
    if (report.usage_state === "used") {
      usedReportIds.add(report.delivery_id);
    }
  }
  return deliveries.filter((delivery) => delivery.pointer_count === 1 && usedReportIds.has(delivery.delivery_id)).length;
}

function deliveryKey(workspaceId: string, deliveryId: string): string {
  return JSON.stringify([workspaceId, deliveryId]);
}

function sessionKey(row: UtilizationBucketDelivery | UtilizationBucketReport): string {
  return JSON.stringify([row.workspace_id, row.agent_target, row.session_id]);
}

function mergeUsageState(a: UsageState, b: UsageState): UsageState {
  if (a === "used" || b === "used") return "used";
  if (a === "skipped" || b === "skipped") return "skipped";
  return "not_applicable";
}
