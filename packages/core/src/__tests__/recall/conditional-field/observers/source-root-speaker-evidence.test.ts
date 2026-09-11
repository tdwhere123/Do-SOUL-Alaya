import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  EvidenceHealthState,
  sourceRecallTarget,
  type Guard,
  type QueryInterpretation,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { buildTypedObservation } from "../../../../recall/conditional-field/observers/observation-admission.js";
import {
  startObserverCursor,
  toSourceRootObserverRow,
  type ObserveConditionalFieldInput,
  type SourceRootObserverRow
} from "../../../../recall/conditional-field/observers/observe.js";
import { defaultView } from "../../../../recall/conditional-field/query/query-admission.js";
import { evaluateFrozenSourcePredicate } from "../../../../recall/conditional-field/query/source-predicates.js";
import { sourceFactKey, type BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { recordSourceRootFacts } from "../../../../recall/runtime/observed-source-facts.js";
import {
  fieldSha256,
  hashedRecord,
  openFieldDatabase
} from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;
const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("source-root speaker and evidence bind", () => {
  it("pins user vs assistant through SqliteSourceRootRecallReader and source.role.v1", () => {
    const { reader, user, assistant } = plantedRoots();
    const page = reader.page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const userRow = toSourceRootObserverRow(page.rows.find((row) => row.root_id === user.record_id)!);
    const assistantRow = toSourceRootObserverRow(
      page.rows.find((row) => row.root_id === assistant.record_id)!
    );
    expect(userRow.role).toBe("user");
    expect(assistantRow.role).toBe("assistant");
    const roleGuard = predicateGuard("source.role.v1", "user");
    expect(evaluateFrozenSourcePredicate("source.role.v1", roleGuard, userRow)).toBe("true");
    expect(evaluateFrozenSourcePredicate("source.role.v1", roleGuard, assistantRow)).toBe("false");
    expect(observeRole(userRow)?.applicability.verdict).toBe("true");
    expect(observeRole(assistantRow)).toBeNull();
  });

  it("pins evidence_link true on a verified bind and false on record-only", () => {
    const { reader, bound, recordOnly } = plantedRoots();
    const page = reader.page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const boundRow = toSourceRootObserverRow(page.rows.find((row) => row.root_id === bound.record_id)!);
    const recordOnlyRow = toSourceRootObserverRow(
      page.rows.find((row) => row.root_id === recordOnly.record_id)!
    );
    expect(boundRow.evidence_verified).toBe(true);
    expect(recordOnlyRow.evidence_verified).toBeUndefined();
    const linkGuard = predicateGuard("source.evidence_link.v1");
    expect(evaluateFrozenSourcePredicate("source.evidence_link.v1", linkGuard, boundRow)).toBe("true");
    expect(evaluateFrozenSourcePredicate("source.evidence_link.v1", linkGuard, recordOnlyRow)).toBe("false");
    expect(observeLink(boundRow)?.applicability.verdict).toBe("true");
    expect(observeLink(recordOnlyRow)).toBeNull();
  });

  it("copies speaker and verified evidence onto observed source facts", () => {
    const { reader, user, bound } = plantedRoots();
    const page = reader.page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const userRow = toSourceRootObserverRow(page.rows.find((row) => row.root_id === user.record_id)!);
    const boundRow = toSourceRootObserverRow(page.rows.find((row) => row.root_id === bound.record_id)!);
    const facts = new Map<string, BoundSourceFacts>();
    recordSourceRootFacts(
      [userRow, boundRow],
      [
        observationFor(userRow),
        observationFor(boundRow)
      ],
      facts
    );
    expect(facts.get(sourceFactKey(observationFor(userRow).target))?.role).toBe("user");
    expect(facts.get(sourceFactKey(observationFor(boundRow).target))?.evidence_verified).toBe(true);
    expect(facts.get(sourceFactKey(observationFor(boundRow).target))?.evidence_object_id).toBe(bound.evidence_object_id);
  });
});

function plantedRoots() {
  const database = openFieldDatabase();
  tracked.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const capsules = new SqliteEvidenceCapsuleRepo(database);
  capsules.createInCurrentTransaction({ object_id: "55555555-5555-4555-8555-555555555555", object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "active", created_at: "2026-08-16T00:00:00.000Z", updated_at: "2026-08-16T00:00:00.000Z", created_by: "user_action",
    evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "source", keywords: ["source"], summary: "source" },
    event_anchor: null, physical_anchor: null, evidence_health_state: EvidenceHealthState.VERIFIED, gist: "bound body", excerpt: "bound body",
    source_hash: null, run_id: "run-1", workspace_id: "workspace-1", surface_id: null });
  const user = records.insert({
    ...hashedRecord("workspace-1", "user said hello", "alaya:artifact:user-turn"),
    speaker: "user"
  });
  const assistant = records.insert({
    ...hashedRecord("workspace-1", "assistant replied", "alaya:artifact:assistant-turn"),
    speaker: "assistant"
  });
  const bound = records.insert({
    ...hashedRecord("workspace-1", "bound body", "alaya:artifact:bound"),
    evidence_object_id: "55555555-5555-4555-8555-555555555555"
  });
  const recordOnly = records.insert(hashedRecord(
    "workspace-1",
    "record only body",
    "alaya:artifact:record-only"
  ));
  return {
    reader: new SqliteSourceRootRecallReader(records, capsules),
    user,
    assistant,
    bound,
    recordOnly
  };
}

function predicateGuard(name: string, entityId?: string): Guard {
  return {
    schema_version: SCHEMA,
    kind: "query_predicate",
    verdict: "unresolved",
    predicate_name: name,
    variable: "x",
    time_scope: "none",
    ...(entityId === undefined ? {} : { entity_id: entityId })
  };
}

function observeRole(row: SourceRootObserverRow) {
  return buildTypedObservation(observeInput(relation("source.role.v1", "user")), {
    objectId: row.root_id,
    sourceRevision: row.revision,
    observationKey: row.root_id,
    sourceRoot: row,
    identityKind: "object"
  });
}

function observeLink(row: SourceRootObserverRow) {
  return buildTypedObservation(observeInput(relation("source.evidence_link.v1")), {
    objectId: row.root_id,
    sourceRevision: row.revision,
    observationKey: row.root_id,
    sourceRoot: row,
    identityKind: "object"
  });
}

function observeInput(program: QueryProgram): ObserveConditionalFieldInput {
  return {
    lease: {
      schema_version: SCHEMA,
      lease_id: "lease",
      snapshot_id: SNAPSHOT_ID,
      query_id: "speaker-evidence",
      status: "active"
    },
    action: {
      schema_version: SCHEMA,
      action: "seed",
      region_id: "seed",
      work_limit: 16
    },
    cursor: startObserverCursor({
      cursor_id: "seed",
      snapshot_id: SNAPSHOT_ID,
      query_id: "speaker-evidence",
      region_id: "seed"
    }),
    query: interpretation(program),
    workspace_id: "workspace-1",
    readers: {},
    authorized_scopes: null
  };
}

function interpretation(program: QueryProgram): QueryInterpretation {
  return {
    schema_version: SCHEMA,
    query_id: "speaker-evidence",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function relation(predicateName: string, entityId?: string): QueryProgram {
  return {
    schema_version: SCHEMA,
    kind: "relation",
    relation_kind: "observed_log",
    source_variable: "x",
    target_variable: "y",
    guard: predicateGuard(predicateName, entityId),
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function observationFor(row: SourceRootObserverRow) {
  return {
    schema_version: SCHEMA,
    observation_id: `seed:${row.root_id}`,
    object_id: row.root_id,
    source_revision: row.revision,
    workspace_id: row.workspace_id,
    applicability: {
      schema_version: SCHEMA,
      kind: "query_predicate" as const,
      verdict: "true" as const
    },
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
