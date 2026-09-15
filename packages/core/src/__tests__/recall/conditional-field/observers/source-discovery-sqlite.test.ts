import type { QueryInterpretation } from "@do-soul/alaya-protocol";
import { meterReaders } from "../../../../recall/runtime/observer-reader-budget.js";
import { takeSourceHintPage } from "../../../../recall/conditional-field/observers/source-hint-observe.js";
import type { ObserverReaders, ObserveConditionalFieldInput } from "../../../../recall/conditional-field/observers/observe.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  locateSourceInterpretation,
  sourceRecallTarget
} from "@do-soul/alaya-protocol";
import {
  SqliteFieldSourceRecordRepo,
  SqliteSourceHintReader,
  SqliteSourceRootRecallReader,
  SqliteEvidenceCapsuleRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { compileQuerySourceSketch } from "../../../../recall/conditional-field/query/query-source-sketch.js";
import { matchBoundInterpretation, parseBoundInterpretationGist } from "../../../../recall/conditional-field/observers/source-proposal-match.js";
import { adoptedSourceProposal } from "../../../../recall/conditional-field/query/query-source-proposal.js";
import {
  observeConditionalField,
  startObserverCursor,
  toSourceRootObserverRow
} from "../../../../recall/conditional-field/observers/observe.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView
} from "../reference/deployment.fixture.js";
import { SOURCE_DISCOVERY_CANARY } from "./source-discovery-canary.fixture.js";
import {
  fieldSha256,
  hashedRecord,
  openFieldDatabase
} from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("source discovery sqlite lookup", () => {
  it("uses the tuple index on initial and resumed scans and charges the empty probe", () => {
    const database = openFieldDatabase(); tracked.add(database);
    for (let i = 0; i < 30; i++) {
      insertBoundGist(database, `hint-${String(i).padStart(2, "0")}`, "alpha", "root", "sha256:" + "a".repeat(64), null, { predicate: "alpha" });
    }
    database.connection.prepare("UPDATE evidence_capsules SET workspace_id='other' WHERE object_id>='hint-03'").run();
    const prepare = vi.spyOn(database.connection, "prepare");
    const reader = new SqliteSourceHintReader(database.connection);
    const matches = vi.fn(() => false);
    const first = reader.pageBoundInterpretations({ workspaceId: "workspace-1", limit: 1, nativeLimit: 2, afterCursor: null, matches });
    const sql = prepare.mock.calls.find(([sql]) => sql.includes("FROM evidence_capsules INDEXED BY"))![0];
    prepare.mockRestore();
    const resumed = reader.pageBoundInterpretations({ workspaceId: "workspace-1", limit: 1, nativeLimit: 2,
      afterCursor: first.committedThrough, matches });
    expect(first).toMatchObject({ rows: [], rowsRead: 2, nativeWork: 2, truncated: true });
    expect(resumed).toMatchObject({ rows: [], rowsRead: 1, nativeWork: 2, truncated: false });
    expect(matches).toHaveBeenCalledTimes(3);
    for (const seek of [["", ""], JSON.parse(first.committedThrough!)]) {
      const plan = database.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(65536, "workspace-1", ...seek) as { detail: string }[];
      expect(plan.some((row) => row.detail.includes("SEARCH evidence_capsules USING INDEX idx_evidence_capsules_source_cursor") &&
        row.detail.includes("(created_at,object_id)>(?,?)"))).toBe(true);
      expect(plan.some((row) => /TEMP B-TREE|SCAN evidence_capsules/.test(row.detail))).toBe(false);
    }
  });

  it.each(["wrong root", "stale revision"] as const)("rejects a schema-valid binding with %s", (state) => {
    const database = openFieldDatabase(); tracked.add(database);
    const record = new SqliteFieldSourceRecordRepo(database, fieldSha256).insert(hashedRecord("workspace-1", "alpha", "bound"));
    insertBoundGist(database, "hint", "alpha", record.record_id, record.content_digest, null, { predicate: "alpha" });
    const column = state === "wrong root" ? "$.source_target.root_id" : "$.source_target.source_version";
    database.connection.prepare("UPDATE evidence_capsules SET gist=json_set(gist, ?, ?) WHERE object_id='hint'")
      .run(column, state === "wrong root" ? "missing-root" : "older-revision");
    const query = simpleQuery("proposal");
    const result = takeSourceHintPage(nativeInput(query, nativeReaders(database)), adoptedSourceProposal(query)!, 1, 7, null);
    expect(result.rows).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.workUnits).toBeGreaterThan(1);
  });

  it.each(["expired", "future", "corrupt", "withdrawn"] as const)(
    "hydrates authoritative source state before either hint lane admits %s bytes", (state) => {
      const database = openFieldDatabase(); tracked.add(database);
      const record = new SqliteFieldSourceRecordRepo(database, fieldSha256).insert({
        ...hashedRecord("workspace-1", "alpha αβγ", "native-state"),
        valid_to: state === "expired" ? "2000-01-01T00:00:00.000Z" : null,
        valid_from: state === "future" ? "2099-01-01T00:00:00.000Z" : state === "expired" ? "1999-01-01T00:00:00.000Z" : null
      });
      insertBoundGist(database, "hint", "alpha αβγ", record.record_id, record.content_digest, null, { predicate: "alpha" });
      if (state === "corrupt") database.connection.prepare("UPDATE retained_source_chunks SET body=?").run(Buffer.from("broken"));
      if (state === "withdrawn") database.connection.prepare("UPDATE source_records SET source_body=NULL").run();
      for (const mode of ["proposal", "source_text"] as const) {
        const query = simpleQuery(mode);
        const memory = { remaining: 65536, cachedBytes: 0 };
        const result = takeSourceHintPage(nativeInput(query, meterReaders(nativeReaders(database), memory, new Map())),
          adoptedSourceProposal(query)!, 1, 7, null);
        expect(result.observations).toEqual([]);
        expect(result.workUnits).toBeGreaterThanOrEqual(2);
        expect(result.workUnits).toBeLessThanOrEqual(6);
        expect(result.bytes).toBe(65536 - memory.remaining);
        expect(result.bytes).toBeGreaterThan(0);
      }
    });

  it("charges complete UTF-8 chunks while returning only an eight-byte text prefix", () => {
    const database = openFieldDatabase(); tracked.add(database);
    new SqliteFieldSourceRecordRepo(database, fieldSha256).insert(hashedRecord("workspace-1", "alpha αβγ", "utf8"));
    const query = simpleQuery("source_text");
    const memory = { remaining: 65536, cachedBytes: 0 };
    const result = takeSourceHintPage({ ...nativeInput(query, meterReaders(nativeReaders(database), memory, new Map())), source_byte_limit: 8 },
      adoptedSourceProposal(query)!, 1, 7, null);
    expect(result.rows[0]?.content).toBe("alpha α");
    expect(result.rows[0]?.content_end).toBe(8);
    expect(result.bytes).toBeGreaterThan(8);
    expect(result.bytes).toBe(65536 - memory.remaining);
  });

  it("retains a matched identity when its hydration reservation cannot fit", () => {
    const database = openFieldDatabase(); tracked.add(database);
    const record = new SqliteFieldSourceRecordRepo(database, fieldSha256).insert(hashedRecord("workspace-1", "alpha αβγ", "pending"));
    insertBoundGist(database, "hint", "alpha αβγ", record.record_id, record.content_digest, null, { predicate: "alpha" });
    const query = simpleQuery("proposal");
    const small = { remaining: 12288, cachedBytes: 0 };
    const pending = takeSourceHintPage(nativeInput(query, meterReaders(nativeReaders(database), small, new Map())),
      adoptedSourceProposal(query)!, 1, 7, null);
    expect(pending.resourceLimited).toBe(true);
    expect(pending.hintCommitted).toBeNull();
    expect(pending.rows).toEqual([]);
    const memory = { remaining: 65536, cachedBytes: 0 };
    const resumed = takeSourceHintPage(nativeInput(query, meterReaders(nativeReaders(database), memory, new Map())),
      adoptedSourceProposal(query)!, 1, 7, pending.hintCommitted);
    expect(resumed.rows.map((row) => row.root_id)).toEqual([record.record_id]);
    expect(resumed.workUnits).toBe(6);
  });

  it.each(SOURCE_DISCOVERY_CANARY.flatMap((canary) => [
    { ...canary, intendedFirst: true }, { ...canary, intendedFirst: false }
  ]))("matches $group before the context cap with intendedFirst=$intendedFirst", (canary) => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const intended = records.insert(hashedRecord("workspace-1", canary.intended, "intended"));
    const distractorInput = Array.from({ length: 128 }, (_, index) =>
      hashedRecord("workspace-1", canary.distractor, `distractor-${index}`)).find((row) =>
        (intended.record_id < row.record_id) === canary.intendedFirst);
    if (distractorInput === undefined) throw new Error("Could not plant requested physical order");
    const distractor = records.insert(distractorInput);
    insertBoundGist(database, intended.record_id, canary.intended, intended.record_id, intended.content_digest, intended.evidence_object_id, canary.sketch);
    insertBoundGist(database, distractor.record_id, canary.distractor, distractor.record_id, distractor.content_digest, distractor.evidence_object_id, {
      ...canary.sketch,
      arguments: canary.sketch.arguments?.map((argument, index) => index === 0
        ? { ...argument, role: "reported" } : argument)
    });
    const interpretation = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      view: { ...defaultView(), result_kind_view: "source_only" },
      sketch: { original_query: canary.original_query, relation: canary.sketch }
    });
    const sketch = adoptedSourceProposal(interpretation);
    expect(sketch).toBeDefined();
    const hints = new SqliteSourceHintReader(database.connection).pageBoundInterpretations({
      workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null
    });
    const matched = hints.rows.flatMap((row) => {
      const bound = parseBoundInterpretationGist(row.gist);
      return bound !== null && matchBoundInterpretation(bound, sketch!) !== undefined
        ? [bound.source_target.root_id] : [];
    });
    expect(matched).toEqual([intended.record_id]);
    const text = new SqliteSourceHintReader(database.connection).pageSourceTextHints({
      workspaceId: "workspace-1",
      phrases: ["access", "full pc", "all the devices you own", "instantly"],
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    expect(text.rows.map((row) => row.root_id).sort()).toEqual(
      [intended.record_id, distractor.record_id].sort()
    );
    const roots = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
    expect(roots.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null }).rows.length).toBeGreaterThan(0);
    const measurement = { candidateScans: 0, hydratedContexts: 0 };
    const readers = nativeReaders(database, measurement);
    const observe = (query: typeof interpretation) => observeConditionalField(nativeInput(query, readers));
    const observed = observe(interpretation);
    const proposalMeasurement = { ...measurement, nativeWork: observed.work.work_units, bytes: observed.work.bytes_read };
    measurement.candidateScans = 0; measurement.hydratedContexts = 0;
    const textQuery = compileQuerySourceSketch({ snapshot_id: SNAPSHOT_ID, budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK, view: { ...defaultView(), result_kind_view: "source_only" },
      sketch: { original_query: canary.original_query, relation: canary.sketch, lookup_mode: "source_text" } });
    const textObserved = observe(textQuery);
    expect(textObserved.page.observations[0]?.object_id).toBe(canary.intendedFirst ? intended.record_id : distractor.record_id);
    expect(observed.work.work_units).toBeLessThanOrEqual(7);
    expect(textObserved.work.work_units).toBeLessThanOrEqual(7);
    expect(proposalMeasurement.hydratedContexts).toBe(1);
    expect(measurement.hydratedContexts).toBe(1);
    console.info(JSON.stringify({ sourceDiscovery: canary.group, intendedFirst: canary.intendedFirst,
      proposal: proposalMeasurement, text: { ...measurement, nativeWork: textObserved.work.work_units, bytes: textObserved.work.bytes_read },
      intendedDiscovered: { proposal: true, text: canary.intendedFirst }, legalExposure: "not measured by observer" }));

    expect(observed.page.observations[0]?.object_id).toBe(intended.record_id);
    expect(observed.lookup_reasons?.[0]?.kind).toBe("proposal");
  });
});

function simpleQuery(lookup_mode: "proposal" | "source_text"): QueryInterpretation {
  return compileQuerySourceSketch({ snapshot_id: SNAPSHOT_ID, budget: defaultBudget(),
    interpretation_clock: INTERPRETATION_CLOCK, view: { ...defaultView(), result_kind_view: "source_only" },
    sketch: { original_query: "alpha", relation: { predicate: "alpha" }, lookup_mode } });
}

function insertBoundGist(
  database: StorageDatabase,
  objectId: string,
  source: string,
  rootId: string,
  digest: string,
  evidenceObjectId: string | null,
  relation: NonNullable<(typeof SOURCE_DISCOVERY_CANARY)[number]["sketch"]>
): void {
  const located = locateSourceInterpretation({
    source,
    artifactKey: objectId,
    sha256: fieldContractSha256,
    assertion: { assertion_id: 1, text: source, source_span: [0, source.length] },
    response: {
      kind: "received",
      value: {
        interpretations: [{
          assertion_id: 1,
          relations: [{
            predicate: { text: relation.predicate },
            arguments: (relation.arguments ?? []).map((item) => ({ role: item.role, phrase: { text: item.phrase } })),
            qualifiers: (relation.qualifiers ?? []).map((item) => ({ role: item.role, phrase: { text: item.phrase } }))
          }]
        }]
      }
    }
  });
  if (located.outcome !== "candidates") {
    throw new Error(`locate failed: ${JSON.stringify(located.diagnostics)}`);
  }
  const bound = {
    ...located,
    source_target: sourceRecallTarget({
      workspace_id: "workspace-1",
      root_kind: "source_record",
      root_id: rootId,
      source_version: "v1",
      content_digest: digest,
      evidence_object_id: evidenceObjectId
    })
  };
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, created_at, updated_at, created_by, evidence_kind, semantic_anchor,
      gist, excerpt, run_id, workspace_id
    ) VALUES (?, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z', 'test',
      'conversation_excerpt', '{}', ?, ?, 'run-1', 'workspace-1')
  `).run(objectId, JSON.stringify(bound), source);
}

function nativeReaders(database: StorageDatabase, measurement = { candidateScans: 0, hydratedContexts: 0 }): ObserverReaders {
  const roots = new SqliteSourceRootRecallReader(new SqliteFieldSourceRecordRepo(database, fieldSha256), new SqliteEvidenceCapsuleRepo(database));
  return {
        sourceRoots: (input: Parameters<NonNullable<ObserverReaders["sourceRoots"]>>[0]) => {
          const page = roots.page(input);
          return { ...page, rows: page.rows.map(toSourceRootObserverRow) };
        },
        boundInterpretations: (input: Parameters<NonNullable<ObserverReaders["boundInterpretations"]>>[0]) => {
          const page = new SqliteSourceHintReader(database.connection).pageBoundInterpretations(input);
          measurement.candidateScans += page.nativeVisits;
          return page;
        },
        sourceTextHints: (input: Parameters<NonNullable<ObserverReaders["sourceTextHints"]>>[0]) => {
          const page = new SqliteSourceHintReader(database.connection).pageSourceTextHints(input);
          measurement.candidateScans += page.nativeVisits;
          return { ...page, rows: page.rows.map(toSourceRootObserverRow) };
        },
        sourceRoot: (input: Parameters<NonNullable<ObserverReaders["sourceRoot"]>>[0]) => {
          measurement.hydratedContexts++;
          const page = roots.hydrate(input.workspaceId, sourceRecallTarget({
            workspace_id: input.workspaceId, root_kind: input.rootKind, root_id: input.rootId,
            source_version: input.revision!, content_digest: input.digest!, evidence_object_id: input.evidenceObjectId ?? null
          }), input.byteLimit, input.offset, input.nativeByteLimit);
          return { ...page, row: page.row === null ? null : toSourceRootObserverRow(page.row) };
        }
    };
}

function nativeInput(query: QueryInterpretation, readers: ObserverReaders): ObserveConditionalFieldInput {
  return {
      lease: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        lease_id: "lease-1",
        snapshot_id: SNAPSHOT_ID,
        query_id: query.query_id,
        status: "active"
      },
      action: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        action: "seed",
        region_id: "seed",
        work_limit: 7
      },
      cursor: startObserverCursor({
        cursor_id: "seed",
        snapshot_id: SNAPSHOT_ID,
        query_id: query.query_id,
        region_id: "seed"
      }),
      query,
      workspace_id: "workspace-1",
      authorized_scopes: null,
      readers
    };
}
