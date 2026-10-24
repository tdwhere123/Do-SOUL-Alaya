import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sourceDisclosure, CONDITIONAL_FIELD_SCHEMA_VERSION,
  indexEntryCacheKey,
  sourceIndexEntry,
  sourceRecallTarget,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { sourceFactKey, type BoundSourceFacts } from "../../../recall/conditional-field/engine/binding-environment.js";
import {
  toSourceRootObserverRow,
  type SourceRootObserverRow
} from "../../../recall/conditional-field/observers/observe.js";
import { BoundedIndexPayload } from "../../../recall/runtime/index-payload.js";
import { recordSourceRootFacts } from "../../../recall/runtime/observed-source-facts.js";
import {
  fieldSha256,
  hashedRecord,
  openFieldDatabase
} from "../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;
const AS_OF = "2026-09-25T10:00:00.000Z";
const OBSERVED_AT = "2026-09-24T08:00:00.000Z";
const KNOWN_TIME = "2024-01-02T03:04:05.000Z";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("observed source event time facts", () => {
  it("keeps known, missing, and checked-null event time distinct through pinned then cached page metadata", () => {
    const { known, absent, missing } = plantedFacts();
    expect(known.facts.event_time).toBe(KNOWN_TIME);
    expect(absent.facts.event_time).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(absent.facts, "event_time")).toBe(true);
    expect(missing.facts.event_time).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(missing.facts, "event_time")).toBe(false);
    expect(pageSourceTime(known, "cached")).toEqual({ kind: "known", at: KNOWN_TIME });
    expect(pageSourceTime(absent, "cached")).toEqual({ kind: "unknown", reason: "not_recorded" });
    expect(pageSourceTime(missing, "cached")).toEqual({ kind: "unknown", reason: "metadata_unavailable" });
  });

  it("keeps a checked-null event time when hydrate fails after facts are written", () => {
    const { absent } = plantedFacts();
    expect(pageSourceTime(absent, "hydrate_fail")).toEqual({ kind: "unknown", reason: "not_recorded" });
  });

  it("does not copy an observation clock onto source event time", () => {
    const { known, absent, missing } = plantedFacts();
    expect(known.facts.observed_at).toBe(OBSERVED_AT);
    expect(absent.facts.observed_at).toBe(OBSERVED_AT);
    expect(missing.facts.observed_at).toBe(OBSERVED_AT);
    expect(known.facts.event_time).toBe(KNOWN_TIME);
    expect(absent.facts.event_time).toBeNull();
    expect(missing.facts.event_time).toBeUndefined();
  });
});

function plantedFacts() {
  const database = openFieldDatabase();
  tracked.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const knownRecord = records.insert({
    ...hashedRecord("workspace-1", "known event body", "src-known"),
    event_time: KNOWN_TIME
  });
  const nullRecord = records.insert(hashedRecord("workspace-1", "null event body", "src-null"));
  const page = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database)).page({
    workspaceId: "workspace-1",
    limit: 8,
    nativeLimit: 8,
    afterCursor: null
  });
  const knownRow = toSourceRootObserverRow(page.rows.find((row) => row.root_id === knownRecord.record_id)!);
  const nullRow = toSourceRootObserverRow(page.rows.find((row) => row.root_id === nullRecord.record_id)!);
  const missingRow: SourceRootObserverRow = {
    kind: "source_record",
    workspace_id: "workspace-1",
    root_id: "missing-root",
    revision: "v1",
    digest: `sha256:${"c".repeat(64)}`,
    evidence_object_id: null,
    valid_from: null,
    valid_to: null
  };
  const facts = new Map<string, BoundSourceFacts>();
  recordSourceRootFacts(
    [knownRow, nullRow, missingRow],
    [observationFor(knownRow), observationFor(nullRow), observationFor(missingRow)],
    facts
  );
  return {
    known: boundPage(facts, knownRow),
    absent: boundPage(facts, nullRow),
    missing: boundPage(facts, missingRow)
  };
}

function boundPage(facts: Map<string, BoundSourceFacts>, row: SourceRootObserverRow) {
  const target = sourceRecallTarget({
    workspace_id: row.workspace_id,
    root_kind: row.kind,
    root_id: row.root_id,
    source_version: row.revision,
    content_digest: row.digest,
    evidence_object_id: row.evidence_object_id
  });
  return {
    facts: facts.get(sourceFactKey(target))!,
    entry: sourceIndexEntry({
      workspace_id: row.workspace_id,
      root_kind: row.kind,
      root_id: row.root_id,
      source_version: row.revision,
      content_digest: row.digest,
      evidence_object_id: row.evidence_object_id,
      association_milligrades: 1000
    })
  };
}

function pageSourceTime(
  bound: ReturnType<typeof boundPage>,
  mode: "cached" | "hydrate_fail"
) {
  const target = bound.entry.target;
  if (target.kind !== "source_evidence") throw new Error("source target required");
  const hydrate = vi.fn(() => ({ row: { ...bound.facts,
    kind: target.root_kind, workspace_id: target.workspace_id, root_id: target.root_id,
    revision: target.source_version, digest: target.content_digest,
    evidence_object_id: target.evidence_object_id, content: "pinned body", content_complete: true },
    rowsRead: 1, bytesRead: 11, unavailable: false }));
  const payload = new BoundedIndexPayload({
    sourceFacts: new Map([[sourceFactKey(bound.entry.target), bound.facts]]),
    ...(mode === "cached"
      ? {
        previewCache: { [indexEntryCacheKey(bound.entry)]: "unbound cached body" },
        readers: { sourceRoot: hydrate }
      }
      : { readers: {} }),
    workspaceId: "workspace-1",
    asOf: AS_OF,
    remainingMemoryBytes: 10_000,
    manifestationFor: () => "excerpt"
  });
  payload.finalize([bound.entry], 20);
  payload.finalize([bound.entry], 20);
  if (mode === "cached") {
    // A preview without a retained source span is not delivery evidence. Hydrate
    // once, then reuse that same payload owner's pinned span and metadata.
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(payload.previews.get(indexEntryCacheKey(bound.entry))).toBe("pinned body");
  }
  const disclosure = payload.sourceMetadata[indexEntryCacheKey(bound.entry)]?.source_disclosure;
  return disclosure === undefined ? undefined : sourceDisclosure(disclosure).source_time;
}

function observationFor(row: SourceRootObserverRow): TypedObservation {
  return {
    schema_version: SCHEMA,
    observation_id: `seed:${row.root_id}`,
    object_id: row.root_id,
    source_revision: row.revision,
    workspace_id: row.workspace_id,
    applicability: {
      schema_version: SCHEMA,
      kind: "query_predicate",
      verdict: "true"
    },
    observed_at: OBSERVED_AT,
    target: sourceRecallTarget({
      workspace_id: row.workspace_id,
      root_kind: row.kind,
      root_id: row.root_id,
      source_version: row.revision,
      content_digest: row.digest,
      evidence_object_id: row.evidence_object_id
    })
  };
}
