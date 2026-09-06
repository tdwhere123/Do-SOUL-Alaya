import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CompletenessReport,
  type CompletenessStatus,
  type IndexEntry,
  type IndexRole,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import {
  CONTRACT_ONLY_UNTIL_C07,
  type TargetConsumerPayload
} from "./consumer-contract.js";

export const SNAPSHOT_ID = `sha256:${"b".repeat(64)}`;
export const QUERY_ID = "failed-deployment";
export const RESULT_VERSION = "v1";
export const FAR_FUTURE_EXPIRY = "2099-01-01T00:00:00.000Z";

export const DEPLOYMENT_MILLIGRADES: Readonly<Record<string, number>> = Object.freeze({
  r: 1000,
  l: 950,
  c: 850,
  s: 900,
  h: 550,
  u: 0
});

export const DEPLOYMENT_ROLES: Readonly<Record<string, IndexRole>> = Object.freeze({
  r: "requested",
  l: "associated",
  c: "associated",
  s: "routing_only",
  h: "associated"
});

export type SourceRow = Readonly<{
  readonly object_id: string;
  readonly generation_id: string;
  readonly retention: "live" | "tombstoned";
  readonly source_revision: string;
}>;

export type AcceptanceFixture = Readonly<{
  readonly id: string;
  readonly rows: readonly SourceRow[];
  readonly reader: Readonly<{
    readonly ids: readonly string[];
    readonly truncated: boolean;
    readonly available: boolean;
  }>;
  readonly worker: "running" | "cancelled";
  readonly provider_calls: number;
  readonly garden_enqueue: number;
}>;

export function stubMcpRecall(_index: InformationIndex): TargetConsumerPayload {
  throw new Error("stubMcpRecall cannot close production rows");
}

export function stubCliRecall(_index: InformationIndex): TargetConsumerPayload {
  throw new Error("stubCliRecall cannot close production rows");
}

export function deploymentEntries(): readonly IndexEntry[] {
  return (["c", "h", "l", "r"] as const).map((objectId) => entry(objectId, DEPLOYMENT_ROLES[objectId]!));
}

export function pagedIndex(pageBudget: number, offset = 0, entries = deploymentEntries()): InformationIndex {
  const page = entries.slice(offset, offset + pageBudget);
  const remaining = entries.length - offset - page.length;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    entries: page,
    completeness: remaining > 0
      ? dimensions("complete", "complete", "partial", "partial", "complete")
      : dimensions("complete", "complete", "complete", "complete", "complete"),
    continuation: remaining > 0
      ? {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          continuation_id: `page-${offset + page.length}`,
          query_id: QUERY_ID,
          snapshot_id: SNAPSHOT_ID,
          result_version: RESULT_VERSION,
          expires_at: FAR_FUTURE_EXPIRY,
          cursor: `offset-${offset + page.length}`
        }
      : null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: pageBudget,
      identity_tie_break: "serialization"
    }
  };
}

export function coverageIndex(
  observed: CompletenessStatus,
  logical: CompletenessStatus = observed === "exhausted_empty" ? "complete" : "open"
): InformationIndex {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    entries: [],
    completeness: dimensions(logical, observed, logical === "complete" ? "complete" : "open", logical === "complete" ? "complete" : "open", "complete"),
    continuation: null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: 800,
      identity_tie_break: "serialization"
    }
  };
}

export function sqliteInterruptedZero(): AcceptanceFixture {
  return fixture("interrupted-zero", liveRows("gen-1"), { ids: [], truncated: true, available: true });
}

export function sqliteTombstoneRestart(): AcceptanceFixture {
  return fixture("tombstone-restart", [
    ...liveRows("gen-1").filter((row) => row.object_id !== "u"),
    { object_id: "u", generation_id: "gen-1", retention: "tombstoned", source_revision: "src-u" }
  ], { ids: ["r", "l", "c", "s", "h"], truncated: false, available: true });
}

export function sqliteMixedGeneration(): AcceptanceFixture {
  return fixture("mixed-generation", [
    ...liveRows("gen-1").slice(0, 3),
    ...liveRows("gen-2").slice(3)
  ], { ids: ["r", "l", "c", "s", "h"], truncated: false, available: true });
}

export function sqliteCancelledWorker(): AcceptanceFixture {
  return fixture("cancelled-worker", liveRows("gen-1"), {
    ids: [],
    truncated: true,
    available: true
  }, "cancelled");
}

export function sqliteNormalEntryCounters(): AcceptanceFixture {
  return fixture("normal-entry-counters", liveRows("gen-1"), {
    ids: ["r", "l", "c"],
    truncated: false,
    available: true
  });
}

function entry(objectId: string, role: IndexRole): IndexEntry {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    object_id: objectId,
    hypothesis_id: "h0",
    output_binding: "default",
    role,
    association_milligrades: DEPLOYMENT_MILLIGRADES[objectId] ?? 0,
    claim: "unknown",
    explanation_ids: []
  };
}

function dimensions(
  logical_index: CompletenessStatus,
  observed_coverage: CompletenessStatus,
  transport: CompletenessStatus,
  payload: CompletenessStatus,
  representation: CompletenessStatus
): CompletenessReport {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    logical_index,
    observed_coverage,
    transport,
    payload,
    representation
  };
}

function liveRows(generationId: string): readonly SourceRow[] {
  return ["r", "l", "c", "s", "h", "u"].map((objectId) => ({
    object_id: objectId,
    generation_id: generationId,
    retention: "live" as const,
    source_revision: `src-${objectId}`
  }));
}

function fixture(
  id: string,
  rows: readonly SourceRow[],
  reader: AcceptanceFixture["reader"],
  worker: AcceptanceFixture["worker"] = "running"
): AcceptanceFixture {
  return { id, rows, reader, worker, provider_calls: 0, garden_enqueue: 0 };
}
