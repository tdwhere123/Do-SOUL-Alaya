import { afterEach, describe, expect, it } from "vitest";
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
  it("finds the published bound interpretation and not the role-swapped distractor", () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const intended = records.insert(hashedRecord("workspace-1", canary.intended, "intended"));
    const distractor = records.insert(hashedRecord("workspace-1", canary.distractor, "distractor"));
    insertBoundGist(database, "a-intended", canary.intended, intended.record_id, intended.content_digest, intended.evidence_object_id, canary.sketch);
    insertBoundGist(database, "z-distractor", canary.distractor, distractor.record_id, distractor.content_digest, distractor.evidence_object_id, {
      predicate: "access",
      arguments: [
        { role: "capability", phrase: "full PC" },
        { role: "devices", phrase: "storage" }
      ],
      qualifiers: [{ role: "temporal", phrase: "instantly" }]
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
    const observed = observeConditionalField({
      lease: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        lease_id: "lease-1",
        snapshot_id: SNAPSHOT_ID,
        query_id: interpretation.query_id,
        status: "active"
      },
      action: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        action: "seed",
        region_id: "seed",
        work_limit: 1
      },
      cursor: startObserverCursor({
        cursor_id: "seed",
        snapshot_id: SNAPSHOT_ID,
        query_id: interpretation.query_id,
        region_id: "seed"
      }),
      query: interpretation,
      workspace_id: "workspace-1",
      authorized_scopes: null,
      readers: {
        sourceRoots: (input) => {
          const page = roots.page({
            workspaceId: input.workspaceId,
            limit: input.limit,
            nativeLimit: input.nativeLimit,
            afterCursor: input.afterCursor,
            byteLimit: input.byteLimit
          });
          return {
            rows: page.rows.map(toSourceRootObserverRow),
            nativeVisits: page.nativeVisits,
            nativeBytes: page.nativeBytes,
            rowsRead: page.rowsRead,
            bytesRead: page.bytesRead,
            truncated: page.truncated,
            committedThrough: page.committedThrough,
            unavailable: page.unavailable
          };
        },
        boundInterpretations: (input) => new SqliteSourceHintReader(database.connection).pageBoundInterpretations(input),
        sourceRoot: (input) => {
          if (input.revision === undefined || input.digest === undefined) {
            return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
          }
          const page = roots.load(input.workspaceId, sourceRecallTarget({
            workspace_id: input.workspaceId,
            root_kind: input.rootKind,
            root_id: input.rootId,
            source_version: input.revision,
            content_digest: input.digest,
            evidence_object_id: input.evidenceObjectId ?? null
          }));
          return {
            row: page.row === null ? null : toSourceRootObserverRow(page.row),
            rowsRead: page.rowsRead,
            bytesRead: page.bytesRead,
            nativeWork: page.nativeWork,
            unavailable: page.unavailable,
            resourceLimited: page.resourceLimited
          };
        }
      }
    });
    expect(observed.page.observations[0]?.object_id).toBe(intended.record_id);
    expect(observed.lookup_reasons?.[0]?.kind).toBe("proposal");
  });
});

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
