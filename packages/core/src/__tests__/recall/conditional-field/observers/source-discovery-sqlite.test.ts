import { afterEach, describe, expect, it } from "vitest";
import {
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
    insertBoundGist(database, "ev-intended", canary.intended, intended.record_id, intended.content_digest, canary.sketch);
    insertBoundGist(database, "ev-distractor", canary.distractor, distractor.record_id, distractor.content_digest, {
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
      phrases: ["access", "full pc", "all owned devices", "instantly"],
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    expect(text.rows.map((row) => row.root_id).sort()).toEqual(
      [intended.record_id, distractor.record_id].sort()
    );
    expect(new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database))
      .page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null }).rows.length).toBeGreaterThan(0);
  });
});

function insertBoundGist(
  database: StorageDatabase,
  objectId: string,
  source: string,
  rootId: string,
  digest: string,
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
      evidence_object_id: objectId
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
