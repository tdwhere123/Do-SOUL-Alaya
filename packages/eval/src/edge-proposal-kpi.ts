import { z } from "zod";

/**
 * @anchor edge-proposal-kpi-aggregator — pure EventLog → KPI fold for
 * Phase B K3.2 (edge_proposal_rate) and K3.4 (edge_proposal_auto_accept).
 *
 * The fold is structurally identical to the token-economy reader pattern
 * in apps/bench-runner/src/longmemeval/token-economy.ts: it accepts plain
 * EventLog row shapes (event_type / workspace_id / created_at /
 * payload_json) so a unit test can stub them without standing up the
 * full storage layer. The bench-runner wires real EventLog rows into the
 * same fold.
 *
 * Honest reporting: when no SOUL_GRAPH_EDGE_PROPOSAL_CREATED rows are
 * observed the rate aggregator returns `undefined`. The auto-accept
 * aggregator returns `undefined` when no decided reviewed events exist.
 * The bench-runner leaves the KPI fields absent in those cases rather
 * than emitting a zero-filled section that downstream consumers would
 * mistake for real data.
 *
 * Package boundary: this aggregator is part of `@do-soul/alaya-eval`, a
 * zod-only leaf package, so it MUST NOT import the protocol package. The
 * event_type strings and minimal payload schemas needed are duplicated
 * here; the protocol package owns the authoritative definitions and is
 * exercised by separate tests there.
 *
 * see also:
 *   packages/protocol/src/events/graph-auditor.ts (authoritative payloads)
 *   packages/core/src/edge-proposal-service.ts (event producer)
 *   apps/bench-runner/src/longmemeval/runner.ts (wiring site)
 */

// invariant: these strings mirror GraphAuditorEventType in
// packages/protocol/src/events/graph-auditor.ts. The protocol package
// owns the authoritative enum; this file duplicates the literals only to
// preserve the alaya-eval zod-only leaf boundary. A protocol-side rename
// would break the join here and break the aggregator tests, which is the
// intended early-warning behavior.
const EDGE_PROPOSAL_CREATED_EVENT_TYPE = "soul.graph.edge_proposal_created";
const EDGE_PROPOSAL_REVIEWED_EVENT_TYPE = "soul.graph.edge_proposal_reviewed";

// Decided status set per Phase B definition. EXPIRED is intentionally
// excluded — expiry is policy-driven, not a review verdict, and including
// it would inflate the K3.4 denominator without a matching numerator.
const STATUS_ACCEPTED = "accepted";
const STATUS_AUTO_ACCEPTED = "auto_accepted";
const STATUS_REJECTED = "rejected";

// Minimal structural schemas. Only the fields the aggregator reads are
// pinned; extra fields on the protocol-side payload are ignored by the
// passthrough so future protocol additions stay forward-compatible.
const CreatedPayloadSchema = z
  .object({
    proposal_id: z.string().min(1),
    trigger_source: z.string().min(1)
  })
  .passthrough();

const ReviewedPayloadSchema = z
  .object({
    proposal_id: z.string().min(1),
    status: z.string().min(1)
  })
  .passthrough();

/** Minimal structural EventLog row the aggregator reads. */
export interface EdgeProposalKpiEventRow {
  readonly event_type: string;
  readonly workspace_id: string;
  readonly created_at: string;
  readonly payload_json: unknown;
}

interface CreatedRecord {
  readonly proposalId: string;
  readonly triggerSource: string;
  readonly workspaceId: string;
  readonly createdAt: string;
}

import type {
  EdgeProposalAutoAccept,
  EdgeProposalRate
} from "./kpi-schema.js";

/**
 * Aggregate K3.2 edge_proposal_rate from SOUL_GRAPH_EDGE_PROPOSAL_CREATED
 * events. Returns `undefined` when no created events were observed, so
 * the bench-runner can leave the KPI field absent in honest reports.
 */
export function aggregateEdgeProposalRate(
  rows: readonly EdgeProposalKpiEventRow[]
): EdgeProposalRate | undefined {
  const created = collectCreatedRecords(rows);
  if (created.length === 0) {
    return undefined;
  }
  const perTriggerSource: Record<string, number> = {};
  for (const record of created) {
    perTriggerSource[record.triggerSource] =
      (perTriggerSource[record.triggerSource] ?? 0) + 1;
  }

  const dayCounts = new Map<string, number>();
  for (const record of created) {
    const day = record.createdAt.slice(0, 10);
    if (day.length !== 10) {
      // ISO datetime parse fell short; skip rather than synthesize a key.
      continue;
    }
    const key = `${record.workspaceId}::${day}`;
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
  }

  const perBucketCounts = [...dayCounts.values()];
  // When the time window collapses to one bucket the min == max == median
  // figure is still a faithful per-workspace-per-day snapshot; we surface
  // it instead of `undefined` so release gates that expect a numeric do
  // not need to special-case single-bucket bench runs.
  const min = perBucketCounts.length === 0 ? 0 : Math.min(...perBucketCounts);
  const max = perBucketCounts.length === 0 ? 0 : Math.max(...perBucketCounts);
  const median =
    perBucketCounts.length === 0 ? 0 : computeMedian(perBucketCounts);

  return {
    schema_version: "bench-edge-proposal-rate.v1",
    total_proposals: created.length,
    per_workspace_per_day_min: min,
    per_workspace_per_day_max: max,
    per_workspace_per_day_median: median,
    per_trigger_source: perTriggerSource
  };
}

/**
 * Aggregate K3.4 edge_proposal_auto_accept from
 * SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED events, joined back to the originating
 * SOUL_GRAPH_EDGE_PROPOSAL_CREATED events so the per-trigger-source rate
 * is keyed by the proposal's trigger source (the reviewed event does not
 * carry that field). Returns `undefined` when no decided reviewed events
 * are observed; spec-compliance honesty over a zero-filled rate.
 */
export function aggregateEdgeProposalAutoAccept(
  rows: readonly EdgeProposalKpiEventRow[]
): EdgeProposalAutoAccept | undefined {
  const created = collectCreatedRecords(rows);
  const createdById = new Map<string, CreatedRecord>();
  for (const record of created) {
    createdById.set(record.proposalId, record);
  }

  let totalDecided = 0;
  let autoAccepted = 0;
  const perTriggerDecided = new Map<string, number>();
  const perTriggerAutoAccepted = new Map<string, number>();

  for (const row of rows) {
    if (row.event_type !== EDGE_PROPOSAL_REVIEWED_EVENT_TYPE) {
      continue;
    }
    const parsed = ReviewedPayloadSchema.safeParse(row.payload_json);
    if (!parsed.success) {
      continue;
    }
    const status = parsed.data.status;
    const isDecided =
      status === STATUS_ACCEPTED ||
      status === STATUS_AUTO_ACCEPTED ||
      status === STATUS_REJECTED;
    if (!isDecided) {
      continue;
    }
    totalDecided += 1;
    if (status === STATUS_AUTO_ACCEPTED) {
      autoAccepted += 1;
    }
    const origin = createdById.get(parsed.data.proposal_id);
    if (origin === undefined) {
      // No matching created event in this window; the reviewed event still
      // counts toward total_decided and auto_accepted, but cannot
      // contribute to per_trigger_source_rate without inventing a key.
      continue;
    }
    perTriggerDecided.set(
      origin.triggerSource,
      (perTriggerDecided.get(origin.triggerSource) ?? 0) + 1
    );
    if (status === STATUS_AUTO_ACCEPTED) {
      perTriggerAutoAccepted.set(
        origin.triggerSource,
        (perTriggerAutoAccepted.get(origin.triggerSource) ?? 0) + 1
      );
    }
  }

  if (totalDecided === 0) {
    return undefined;
  }

  const perTriggerSourceRate: Record<string, number> = {};
  for (const [triggerSource, decided] of perTriggerDecided) {
    if (decided === 0) {
      continue;
    }
    const accepted = perTriggerAutoAccepted.get(triggerSource) ?? 0;
    perTriggerSourceRate[triggerSource] = accepted / decided;
  }

  return {
    schema_version: "bench-edge-proposal-auto-accept.v1",
    total_decided: totalDecided,
    auto_accepted: autoAccepted,
    rate: autoAccepted / totalDecided,
    per_trigger_source_rate: perTriggerSourceRate
  };
}

function collectCreatedRecords(
  rows: readonly EdgeProposalKpiEventRow[]
): readonly CreatedRecord[] {
  const records: CreatedRecord[] = [];
  for (const row of rows) {
    if (row.event_type !== EDGE_PROPOSAL_CREATED_EVENT_TYPE) {
      continue;
    }
    const parsed = CreatedPayloadSchema.safeParse(row.payload_json);
    if (!parsed.success) {
      continue;
    }
    records.push({
      proposalId: parsed.data.proposal_id,
      triggerSource: parsed.data.trigger_source,
      workspaceId: row.workspace_id,
      createdAt: row.created_at
    });
  }
  return records;
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
