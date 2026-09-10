import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  EvidenceHealthState,
  type Guard,
  type QueryInterpretation,
  type QueryProgram,
  type SnapshotReadLease
} from "@do-soul/alaya-protocol";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { sourceRootEligible } from "../../../../recall/conditional-field/observers/observation-admission.js";
import {
  observeConditionalField,
  startObserverCursor,
  toSourceRootObserverRow,
  type ObserveConditionalFieldInput,
  type SourceRootObserverPage,
  type SourceRootObserverRow
} from "../../../../recall/conditional-field/observers/observe.js";
import { defaultView } from "../../../../recall/conditional-field/query/query-admission.js";
import {
  fieldSha256,
  hashedRecord,
  openFieldDatabase
} from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;
const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const QUERY_ID = "seam-source";
const NEEDLE = "NEEDLE_ONLY_AFTER_64K";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("source-root seam membership", () => {
  it("finds a needle only in bytes after 64KiB on continuation", () => {
    const { reader, record } = plantedBody("a".repeat(65_536) + NEEDLE);
    const first = observeConditionalField(seedInput({
      program: literalProgram(NEEDLE),
      readers: readerFor(reader),
      source_byte_limit: 65_536
    }));
    const firstRow = first.page.observations.find((row) => row.object_id === record.record_id);
    expect(firstRow?.applicability.verdict).toBe("unresolved");
    expect(first.page.outcome.status).toBe("interrupted");
    expect(first.page.cursor.committed_through?.startsWith("o:")).toBe(true);

    let page = first;
    let matched = false;
    for (let chunk = 0; chunk < 20 && !matched; chunk += 1) {
      const prior = page.page.cursor;
      page = observeConditionalField(seedInput({ program: literalProgram(NEEDLE), readers: readerFor(reader),
        cursor: prior, source_byte_limit: 65_536 }));
      expect(page.page.cursor.committed_through).not.toBe(prior.committed_through);
      matched = page.page.observations.some((row) => row.object_id === record.record_id && row.applicability.verdict === "true");
    }
    expect(matched).toBe(true);
  });

  it("keeps authorized_scopes to persisted scope_class and fail-closes omitted scope", () => {
    const { reader, project, other, omitted } = plantedScopedRoots();
    const page = reader.page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const asObserver = (rootId: string) => toSourceRootObserverRow(
      page.rows.find((row) => row.root_id === rootId)!
    );
    const input = seedInput({
      program: relation("observed_log"),
      authorized_scopes: ["project"]
    });
    expect(asObserver(project.record_id).scope_class).toBe("project");
    expect(asObserver(other.record_id).scope_class).toBe("global_domain");
    expect(asObserver(omitted.record_id).scope_class).toBeUndefined();
    expect(sourceRootEligible(input, asObserver(project.record_id))).toBe(true);
    expect(sourceRootEligible(input, asObserver(other.record_id))).toBe(false);
    expect(sourceRootEligible(input, asObserver(omitted.record_id))).toBe(false);

    const observed = observeConditionalField(seedInput({
      program: relation("observed_log"),
      readers: readerFor(reader),
      authorized_scopes: ["project"]
    }));
    const ids = observed.page.observations.map((row) => row.object_id);
    expect(ids).toContain(project.record_id);
    expect(ids).not.toContain(other.record_id);
    expect(ids).not.toContain(omitted.record_id);
  });

  it("observes a capsule-only exact source without draining unrelated records", async () => {
    const needle = "CAPSULE_ONLY_NEEDLE";
    const { reader, capsuleId } = await plantedCapsuleAmongRecords(needle, 24);
    const observed = observeConditionalField(seedInput({
      program: literalProgram(needle),
      readers: readerFor(reader),
      actionWork: 10,
      page_limit: 4
    }));
    expect(observed.page.observations.some((row) => row.object_id === capsuleId)).toBe(true);
    expect(observed.work.native_visits).toBeLessThan(24);
    const hit = observed.page.observations.find((row) => row.object_id === capsuleId);
    expect(hit?.applicability.verdict).toBe("true");
  });

  it("observes exact lexical memory while unrelated source roots remain", () => {
    const memoryId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000099";
    const sources: SourceRootObserverRow[] = Array.from({ length: 24 }, (_, index) => sourceRoot({
      root_id: `root-${String(index).padStart(2, "0")}`,
      content: `unrelated body ${index}`,
      content_complete: true
    }));
    const observed = observeConditionalField(seedInput({
      program: relation("observed_log"),
      view: "mixed",
      seed_query: "exact-memory-needle",
      actionWork: 4,
      page_limit: 4,
      readers: {
        sourceRoots: (input) => {
          const take = Math.max(0, Math.min(input.limit, input.nativeLimit, sources.length));
          return sourcePage(
            sources.slice(0, take),
            take < sources.length && take === Math.min(input.limit, input.nativeLimit),
            take === 0 ? null : `r:2026-01-01T00:00:00.000Z\t${sources[take - 1]!.root_id}`
          );
        },
        lexical: () => ({
          ids: [memoryId],
          nativeVisits: 1,
          nativeBytes: 8,
          rowsRead: 1,
          bytesRead: 8,
          truncated: false,
          committedThrough: memoryId
        }),
        source: (input) => ({
          row: input.objectId === memoryId
            ? {
              object_id: memoryId,
              sourceRevision: "rev-1",
              lifecycle_state: "active",
              content: "exact-memory-needle"
            }
            : null,
          rowsRead: 1,
          bytesRead: 8,
          unavailable: false
        })
      }
    }));
    expect(observed.page.observations.some((row) => row.object_id === memoryId)).toBe(true);
  });
});

function plantedBody(body: string) {
  const database = openFieldDatabase();
  tracked.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const record = records.insert(hashedRecord("workspace-1", body, "src-oversize"));
  return {
    reader: new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database)),
    record
  };
}

async function plantedCapsuleAmongRecords(needle: string, recordCount: number) {
  const database = openFieldDatabase();
  tracked.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const capsules = new SqliteEvidenceCapsuleRepo(database);
  for (let index = 0; index < recordCount; index += 1) {
    records.insert(hashedRecord("workspace-1", `unrelated body ${index}`, `src-unrelated-${index}`));
  }
  const stored = await capsules.create({
    object_id: "99999999-9999-4999-8999-999999999999",
    object_kind: "evidence_capsule" as const,
    schema_version: 1 as const,
    lifecycle_state: "active" as const,
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    created_by: "user_action" as const,
    evidence_kind: "conversation_excerpt" as const,
    semantic_anchor: { topic: "source", keywords: ["source"], summary: needle },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: EvidenceHealthState.VERIFIED,
    gist: needle,
    excerpt: needle,
    source_hash: null,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  });
  return {
    reader: new SqliteSourceRootRecallReader(records, capsules),
    capsuleId: stored.object_id
  };
}

function plantedScopedRoots() {
  const database = openFieldDatabase();
  tracked.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const project = records.insert({
    ...hashedRecord("workspace-1", "project body", "src-project"),
    scope_class: "project"
  });
  const other = records.insert({
    ...hashedRecord("workspace-1", "global body", "src-global"),
    scope_class: "global_domain"
  });
  const omitted = records.insert(hashedRecord("workspace-1", "omitted body", "src-omitted"));
  return {
    reader: new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database)),
    project,
    other,
    omitted
  };
}

function readerFor(reader: SqliteSourceRootRecallReader): ObserveConditionalFieldInput["readers"] {
  return {
    sourceRoots: (input) => {
      const page = reader.page({
        workspaceId: input.workspaceId,
        query: input.query,
        limit: input.limit,
        nativeLimit: input.nativeLimit,
        afterCursor: input.afterCursor,
        byteLimit: input.byteLimit,
        nativeByteLimit: input.nativeByteLimit,
        workLimit: input.workLimit
      });
      return {
        rows: page.rows.map(toSourceRootObserverRow),
        nativeVisits: page.nativeVisits,
        nativeBytes: page.nativeBytes,
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        metadataBytes: page.metadataBytes,
        nativeWork: page.nativeWork,
        resourceLimited: page.resourceLimited,
        truncated: page.truncated,
        committedThrough: page.committedThrough,
        unavailable: page.unavailable
      };
    }
  };
}

function seedInput(input: Readonly<{
  readonly program: QueryProgram;
  readonly readers?: ObserveConditionalFieldInput["readers"];
  readonly cursor?: ObserveConditionalFieldInput["cursor"];
  readonly source_byte_limit?: number;
  readonly authorized_scopes?: readonly string[];
  readonly seed_query?: string;
  readonly view?: "mixed" | "source_only";
  readonly actionWork?: number;
  readonly page_limit?: number;
}>): ObserveConditionalFieldInput {
  return {
    lease: lease(),
    action: {
      schema_version: SCHEMA,
      action: "seed",
      region_id: "seed",
      work_limit: input.actionWork ?? 16
    },
    cursor: input.cursor ?? startObserverCursor({
      cursor_id: "seed",
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: "seed"
    }),
    query: interpretation(input.program, input.view ?? "source_only"),
    workspace_id: "workspace-1",
    seed_query: input.seed_query ?? NEEDLE,
    readers: input.readers ?? {},
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(input.source_byte_limit === undefined ? {} : { source_byte_limit: input.source_byte_limit }),
    ...(input.page_limit === undefined ? {} : { page_limit: input.page_limit })
  };
}

function interpretation(
  program: QueryProgram,
  view: "mixed" | "source_only"
): QueryInterpretation {
  return {
    schema_version: SCHEMA,
    query_id: QUERY_ID,
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: { ...defaultView(), result_kind_view: view },
    holes: [],
    hypotheses: []
  };
}

function literalProgram(needle: string): QueryProgram {
  return relation("observed_log", {
    kind: "query_predicate",
    predicate_name: "source.literal.nfc.v1",
    entity_id: needle,
    variable: "r"
  });
}

function relation(
  relationKind: string,
  guard: Partial<Guard> = {}
): Extract<QueryProgram, { readonly kind: "relation" }> {
  return {
    schema_version: SCHEMA,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: "r",
    target_variable: "l",
    guard: {
      schema_version: SCHEMA,
      kind: guard.kind ?? "query_predicate",
      verdict: "unresolved",
      variable: guard.variable ?? "r",
      time_scope: guard.time_scope ?? "none",
      ...(guard.predicate_name === undefined ? {} : { predicate_name: guard.predicate_name }),
      ...(guard.entity_id === undefined ? {} : { entity_id: guard.entity_id })
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function sourceRoot(overrides: Partial<SourceRootObserverRow> = {}): SourceRootObserverRow {
  return {
    kind: "source_record",
    workspace_id: "workspace-1",
    root_id: "root-1",
    revision: "v1",
    digest: SNAPSHOT_ID,
    evidence_object_id: null,
    ...overrides
  };
}

function sourcePage(
  rows: readonly SourceRootObserverRow[],
  truncated: boolean,
  committedThrough: string | null
): SourceRootObserverPage {
  return {
    rows,
    nativeVisits: rows.length,
    nativeBytes: 8,
    rowsRead: rows.length,
    bytesRead: 8,
    truncated,
    committedThrough
  };
}

function lease(): SnapshotReadLease {
  return {
    schema_version: SCHEMA,
    lease_id: "lease",
    snapshot_id: SNAPSHOT_ID,
    query_id: QUERY_ID,
    status: "active"
  };
}
