import {
  hashContentDigest,
  type AddressableSourceSpan,
  type FactorDescriptor,
  type FactorIncidence,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";

import type {
  FieldFormationStores,
  SourceRecordEvidenceBinding,
  StoredSourceRecord
} from "../../../../memory/evidence-create/field-stores.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import {
  createSelectedSliceKeyV2,
  type SelectedSliceKeyV2
} from "../../../flood/slice-key-contract.js";
import { digestRecallFieldIdentity } from "../../field-identity.js";

export type SourceProjectionState = Readonly<{
  readonly scope: string;
  readonly event_time: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly lifecycle_state: "active" | "inactive";
  readonly governance_state: "ordinary_evidence" | "restricted";
  readonly sealed: boolean;
  readonly erased: boolean;
  readonly revoked: boolean;
  readonly evidence_transitions?: readonly SourceEvidenceTransition[];
  readonly governance_effects: readonly Readonly<{
    readonly action: "activate" | "revoke" | "seal" | "erase";
    readonly effective_as_of: string;
  }>[];
}>;

export type SourceEvidenceTransition = Readonly<{
  readonly kind: "health" | "lifecycle";
  readonly from_state: string;
  readonly to_state: string;
  readonly effective_as_of: string;
}>;

export type SourceProjectionSliceKey = SelectedSliceKeyV2 & Readonly<{
  readonly source_state: SourceProjectionState;
}>;

export type SourceProjectionSnapshot = Readonly<{
  readonly input_event_frontier: string;
  readonly slice_keys: readonly SourceProjectionSliceKey[];
}>;

export function projectSourceFormationSnapshot(input: Readonly<{
  readonly workspaceId: string;
  readonly stores: FieldFormationStores;
  readonly resolveState: (input: Readonly<{
    readonly record: SourceRecordIdentity;
    readonly evidenceId: string;
    readonly scope: string;
  }>) => SourceProjectionState;
}>): SourceProjectionSnapshot {
  const rows = readFormationRows(input.stores, input.workspaceId);
  const sliceKeys = projectSliceKeys(rows, input.resolveState);
  return Object.freeze({
    input_event_frontier: digestRecallFieldIdentity(rows),
    slice_keys: Object.freeze(sliceKeys)
  });
}

type FormationRows = Readonly<{
  readonly records: readonly SourceRecordIdentity[];
  readonly bindings: readonly SourceRecordEvidenceBinding[];
  readonly spans: readonly AddressableSourceSpan[];
  readonly factors: readonly FactorDescriptor[];
  readonly incidences: readonly FactorIncidence[];
}>;

function readFormationRows(
  stores: FieldFormationStores,
  workspaceId: string
): FormationRows {
  const records = verifyStoredRecords(stores.listStoredRecords(workspaceId));
  return Object.freeze({
    records: sortByIdentity(records),
    bindings: Object.freeze([...stores.listRecordEvidenceBindings(workspaceId)].sort(
      (left, right) => compareText(
        `${left.record_id}\0${left.evidence_object_id}`,
        `${right.record_id}\0${right.evidence_object_id}`
      )
    )),
    spans: sortByIdentity(stores.listSpans(workspaceId)),
    factors: sortByIdentity(stores.listFactors(workspaceId)),
    incidences: sortByIdentity(stores.listIncidences(workspaceId))
  });
}

function verifyStoredRecords(
  records: readonly StoredSourceRecord[]
): readonly SourceRecordIdentity[] {
  return Object.freeze(records.map(({ record, content_bytes: content }) => {
    if (hashContentDigest(content, fieldContractSha256) !== record.content_digest) {
      throw new Error("stored source body does not match its immutable digest");
    }
    return record;
  }));
}

function projectSliceKeys(
  rows: FormationRows,
  resolveState: Parameters<typeof projectSourceFormationSnapshot>[0]["resolveState"]
): readonly SourceProjectionSliceKey[] {
  const records = new Map(rows.records.map((row) => [row.identity, row]));
  const spans = new Map(rows.spans.map((row) => [row.identity, row]));
  const factors = new Map(rows.factors.map((row) => [row.identity, row]));
  const bindings = groupBindings(rows.bindings);
  const byId = new Map<string, SourceProjectionSliceKey>();
  for (const incidence of rows.incidences) {
    const span = spans.get(incidence.span_id);
    const factor = factors.get(incidence.factor_id);
    const record = span === undefined ? undefined : records.get(span.record_id);
    const payload = factor?.canonical_payload;
    if (
      record === undefined ||
      span === undefined ||
      factor === undefined ||
      !isLegalSourceSliceValue(payload)
    ) {
      continue;
    }
    for (const evidenceId of bindings.get(record.identity) ?? []) {
      const key = sourceSliceKey(
        record,
        span,
        factor,
        payload,
        evidenceId,
        resolveState({ record, evidenceId, scope: incidence.scope })
      );
      byId.set(key.key_id, key);
    }
  }
  return Object.freeze([...byId.values()].sort((left, right) =>
    compareText(left.key_id, right.key_id)
  ));
}

function sourceSliceKey(
  record: SourceRecordIdentity,
  span: AddressableSourceSpan,
  factor: FactorDescriptor,
  canonicalPayload: string,
  evidenceId: string,
  sourceState: SourceProjectionState
): SourceProjectionSliceKey {
  const key = createSelectedSliceKeyV2({
    workspace_id: record.workspace_id,
    owner_id: evidenceId,
    dimension: "semantic",
    value: canonicalPayload,
    authority: factor.family === "f3" ? "proposed_routing_only" : "grounded",
    reliability: factor.family === "f3" ? null : 1,
    independence_group: record.source_id,
    provenance: { kind: "signal_fact", source_ref: span.identity },
    source_version: record.source_version,
    freshness: {
      state: "fresh",
      as_of_ms: Date.parse(record.event_time ?? record.recorded_at)
    }
  });
  return Object.freeze({
    ...key,
    source_state: sourceState
  });
}

function isLegalSourceSliceValue(payload: string | null | undefined): payload is string {
  // Empty after trim/NFC is not a legal slice-key value.
  return payload != null && payload.trim().normalize("NFC").length > 0;
}

function groupBindings(
  rows: readonly SourceRecordEvidenceBinding[]
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const values = grouped.get(row.record_id) ?? [];
    values.push(row.evidence_object_id);
    grouped.set(row.record_id, values);
  }
  return grouped;
}

function sortByIdentity<T extends Readonly<{ identity: string }>>(rows: readonly T[]): readonly T[] {
  return Object.freeze([...rows].sort((left, right) => compareText(left.identity, right.identity)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
