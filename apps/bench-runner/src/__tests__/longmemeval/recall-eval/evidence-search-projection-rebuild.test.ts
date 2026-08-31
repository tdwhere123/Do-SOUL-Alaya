import { copyFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { materializeEvidenceFactFrameFormation } from "@do-soul/alaya-core";
import {
  initDatabase,
  readSchemaMigrationLedger,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceSearchProjectionRebuildError,
  rebuildEvidenceSearchProjectionsOnWorkingCopy
} from "../../../runs/snapshot/recall-eval/evidence-search-projection-rebuild.js";
import { prepareRecallEvalRunContext } from
  "../../../runs/lifecycle/recall-eval/recall-eval-run-context.js";
import {
  cleanupProjectionRebuildFixtures,
  createSourceFixture,
  deleteMaterializationEvents,
  duplicateMaterializationEvent,
  fileSha256,
  insertStaleProjection,
  message,
  readProjectionRows,
  type SeededOwner
} from "./evidence-search-projection-rebuild-fixture.js";

const V2_SOURCE_HASH_PREFIX = "sha256:garden-source-turn-fallback-v2:";

afterEach(async () => {
  await cleanupProjectionRebuildFixtures();
});

describe("receipt-v2 evidence search projection rebuild", () => {
  it("rebuilds only the working copy and deterministically replaces every owner", async () => {
    const fixture = await createSourceFixture([
      {
        signalId: "signal-assertions",
        evidenceId: "10000000-0000-4000-8000-000000000001",
        messages: [
          message("u1", "user", "I bought my bookshelf from IKEA. Have you heard of it?"),
          message("a1", "assistant", "I recommended the moss-green TrailShell pack."),
          message("u2", "user", "I named my playlist Summer Vibes.")
        ]
      },
      {
        signalId: "signal-question",
        evidenceId: "10000000-0000-4000-8000-000000000002",
        messages: [message("u3", "user", "Where did I buy my bookshelf?")]
      },
      {
        signalId: "signal-legacy",
        evidenceId: "10000000-0000-4000-8000-000000000003",
        messages: [message("u4", "user", "Legacy evidence stays outside v2 rebuild.")],
        receiptVersion: 1
      }
    ]);
    const sourceBefore = await fileSha256(fixture.sourceDbPath);
    const workingDbPath = join(fixture.root, "working.db");
    await copyFile(fixture.sourceDbPath, workingDbPath);

    const inputDbSha256 = await fileSha256(workingDbPath);
    const first = await rebuildEvidenceSearchProjectionsOnWorkingCopy({ workingDbPath });
    expect(first).toMatchObject({
      schema_version: 1,
      promotable: false,
      input_db_sha256: inputDbSha256,
      rebuilt_db_identity_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      source_schema_version: fixture.currentSchemaVersion,
      working_schema_version: fixture.currentSchemaVersion,
      eligible_owner_count: 2,
      rebuilt_owner_count: 2,
      rejected_owner_count: 0,
      zero_child_owner_count: 1,
      nonzero_child_owner_count: 1,
      child_count: 3,
      projection_kind_counts: [
        { projection_kind: "assistant_observation", child_count: 1 },
        { projection_kind: "user_assertion", child_count: 2 }
      ],
      projection_content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      fact_frame_formation: {
        schema_version: 1,
        capture_count: 0,
        source_bound_count: 0,
        status_counts: [],
        producer_operator_counts: [],
        capture_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    expect(readSchemaMigrationLedger(fixture.sourceDbPath).at(-1))
      .toBe(fixture.currentSchemaVersion);
    expect(readSchemaMigrationLedger(workingDbPath).at(-1))
      .toBe(fixture.currentSchemaVersion);
    expect(await fileSha256(fixture.sourceDbPath)).toBe(sourceBefore);

    const rowsAfterFirst = readProjectionRows(workingDbPath);
    expect(rowsAfterFirst.map((row) =>
      `${row.projection_kind}:${row.projection_id}`
    )).toEqual([
      "assistant_observation:1",
      "user_assertion:1",
      "user_assertion:2"
    ]);
    insertStaleProjection(workingDbPath, fixture.evidenceIds[0]!);
    const secondInputDbSha256 = await fileSha256(workingDbPath);
    const second = await rebuildEvidenceSearchProjectionsOnWorkingCopy({ workingDbPath });

    expect(second).toEqual({
      ...first,
      source_schema_version: fixture.currentSchemaVersion,
      input_db_sha256: secondInputDbSha256,
      rebuilt_db_identity_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(readProjectionRows(workingDbPath)).toEqual(rowsAfterFirst);
    expect(await fileSha256(fixture.sourceDbPath)).toBe(sourceBefore);
  });

  it.each([
    {
      mismatch: "source_hash",
      expectedReason: "source_hash",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules SET source_hash = ? WHERE object_id = ?
        `).run(`${V2_SOURCE_HASH_PREFIX}${"0".repeat(64)}`, fixture.evidenceId);
      }
    },
    {
      mismatch: "workspace",
      expectedReason: "workspace",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules SET workspace_id = 'workspace-2' WHERE object_id = ?
        `).run(fixture.evidenceId);
      }
    },
    {
      mismatch: "receipt",
      expectedReason: "receipt",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?
        `).run(JSON.stringify({
          ...fixture.signal.raw_payload,
          full_turn_content: "User: receipt-altering replacement"
        }), fixture.signal.signal_id);
      }
    },
    {
      mismatch: "artifact_ref",
      expectedReason: "artifact_ref",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules
          SET physical_anchor = json_set(physical_anchor, '$.artifact_ref', NULL)
          WHERE object_id = ?
        `).run(fixture.evidenceId);
      }
    },
    {
      mismatch: "source_hash",
      expectedReason: "source_hash",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules SET source_hash = NULL WHERE object_id = ?
        `).run(fixture.evidenceId);
      }
    },
    {
      mismatch: "runtime envelope",
      expectedReason: "runtime qualification failed",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules SET created_by = 'system' WHERE object_id = ?
        `).run(fixture.evidenceId);
      }
    },
    {
      mismatch: "runtime gist binding",
      expectedReason: "runtime qualification failed",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules SET gist = 'tampered gist' WHERE object_id = ?
        `).run(fixture.evidenceId);
      }
    },
    {
      mismatch: "runtime run binding",
      expectedReason: "runtime qualification failed",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules SET run_id = 'run-2' WHERE object_id = ?
        `).run(fixture.evidenceId);
      }
    },
    {
      mismatch: "runtime surface binding",
      expectedReason: "runtime qualification failed",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        db.connection.prepare(`
          UPDATE evidence_capsules SET surface_id = 'surface-other' WHERE object_id = ?
        `).run(fixture.evidenceId);
      }
    },
    {
      mismatch: "missing materialization",
      expectedReason: "runtime qualification failed",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        deleteMaterializationEvents(db, fixture.signal.signal_id);
      }
    },
    {
      mismatch: "duplicate materialization",
      expectedReason: "runtime qualification failed",
      mutate(db: StorageDatabase, fixture: SeededOwner) {
        duplicateMaterializationEvent(db, fixture);
      }
    }
  ])("fails loudly and atomically on $mismatch mismatch", async ({
    mismatch,
    expectedReason,
    mutate
  }) => {
    const fixture = await createSourceFixture([{
      signalId: `signal-${mismatch}`,
      evidenceId: "20000000-0000-4000-8000-000000000001",
      messages: [message("u1", "user", "I bought my bookshelf from IKEA.")]
    }], mutate);
    const sourceBefore = await fileSha256(fixture.sourceDbPath);
    const workingDbPath = join(fixture.root, "working.db");
    await copyFile(fixture.sourceDbPath, workingDbPath);

    let caught: unknown;
    try {
      await rebuildEvidenceSearchProjectionsOnWorkingCopy({ workingDbPath });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EvidenceSearchProjectionRebuildError);
    expect(caught).toMatchObject({
      message: expect.stringMatching(new RegExp(expectedReason, "u")),
      report: {
        eligible_owner_count: 1,
        rebuilt_owner_count: 0,
        rejected_owner_count: 1,
        child_count: 0,
        promotable: false
      }
    });
    expect(readProjectionRows(workingDbPath)).toEqual([]);
    expect(await fileSha256(fixture.sourceDbPath)).toBe(sourceBefore);
  });

  it("derives the same pre-run database identity for independent A/B copies", async () => {
    const fixture = await createSourceFixture([{
      signalId: "signal-pair",
      evidenceId: "30000000-0000-4000-8000-000000000000",
      messages: [
        message("u1", "user", "I bought my bookshelf from IKEA."),
        message("a1", "assistant", "I recommended the moss-green TrailShell pack.")
      ]
    }]);
    const cellA = join(fixture.root, "cell-a.db");
    const cellB = join(fixture.root, "cell-b.db");
    await Promise.all([
      copyFile(fixture.sourceDbPath, cellA),
      copyFile(fixture.sourceDbPath, cellB)
    ]);

    const reportA = await rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath: cellA
    });
    const reportB = await rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath: cellB
    });

    expect(reportB).toEqual(reportA);
  });

  it("rebuilds a typed projection for an Assistant-only verified owner", async () => {
    const fixture = await createSourceFixture([{
      signalId: "signal-assistant-only",
      evidenceId: "30000000-0000-4000-8000-000000000003",
      messages: [
        message("a1", "assistant", "Use the moss-green TrailShell pack in rain.")
      ]
    }]);
    const workingDbPath = join(fixture.root, "assistant-only.db");
    await copyFile(fixture.sourceDbPath, workingDbPath);

    const report = await rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath
    });

    expect(report).toMatchObject({
      eligible_owner_count: 1,
      rebuilt_owner_count: 1,
      rejected_owner_count: 0,
      zero_child_owner_count: 0,
      nonzero_child_owner_count: 1,
      child_count: 1,
      projection_kind_counts: [{
        projection_kind: "assistant_observation",
        child_count: 1
      }]
    });
    expect(readProjectionRows(workingDbPath)).toMatchObject([{
      evidence_object_id: fixture.evidenceIds[0],
      projection_kind: "assistant_observation",
      content: "Use the moss-green TrailShell pack in rain."
    }]);
  });

  it("replays a formed capture when replacing projections on a current schema", async () => {
    const fixture = await createSourceFixture([{
      signalId: "signal-formed-replay",
      evidenceId: "30000000-0000-4000-8000-000000000004",
      messages: [message("u1", "user", "I use Atlas.")]
    }]);
    const workingDbPath = join(fixture.root, "formed-replay.db");
    await copyFile(fixture.sourceDbPath, workingDbPath);
    await rebuildEvidenceSearchProjectionsOnWorkingCopy({ workingDbPath });
    seedFormedCapture(workingDbPath, fixture.evidenceIds[0]!);
    const canonicalFactKeys = readProjectionRows(workingDbPath)
      .filter(({ projection_kind: kind }) => kind === "fact_key");
    tamperFactKeys(workingDbPath, fixture.evidenceIds[0]!);

    const report = await rebuildEvidenceSearchProjectionsOnWorkingCopy({ workingDbPath });

    expect(report).toMatchObject({
      child_count: 5,
      projection_kind_counts: [
        { projection_kind: "fact_key", child_count: 4 },
        { projection_kind: "user_assertion", child_count: 1 }
      ],
      fact_frame_formation: {
        capture_count: 1,
        source_bound_count: 1,
        status_counts: [{ status: "formed", capture_count: 1 }],
        producer_operator_counts: [{
          producer_operator_id: "test_current_schema_formation_v1",
          capture_count: 1
        }],
        capture_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    const rebuiltFactKeys = readProjectionRows(workingDbPath)
      .filter(({ projection_kind: kind }) => kind === "fact_key");
    expect(rebuiltFactKeys).toEqual(canonicalFactKeys);
    expect(rebuiltFactKeys.map(({ content }) => content)).toEqual([
        "I use Atlas",
        "use Atlas",
        "I Atlas",
        "I use"
      ]);
  });

  it("rejects a restore target that aliases the source snapshot", async () => {
    const fixture = await createSourceFixture([{
      signalId: "signal-alias",
      evidenceId: "30000000-0000-4000-8000-000000000001",
      messages: [message("u1", "user", "I bought my bookshelf from IKEA.")]
    }]);
    const aliasedSourcePath = join(fixture.root, "alaya.db");
    await copyFile(fixture.sourceDbPath, aliasedSourcePath);
    const sourceBefore = await fileSha256(aliasedSourcePath);
    const ledgerBefore = readSchemaMigrationLedger(aliasedSourcePath);

    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: aliasedSourcePath,
      variant: "longmemeval_s",
      historyRoot: join(fixture.root, "history"),
      dataDirRoot: fixture.root,
      experiment: true,
      derivedEvidenceProjectionRebuild: true
    }, undefined, {})).rejects.toThrow(/source snapshot must differ/u);

    expect(await fileSha256(aliasedSourcePath)).toBe(sourceBefore);
    expect(readSchemaMigrationLedger(aliasedSourcePath)).toEqual(ledgerBefore);
  });

  it("rejects a symlinked restore root that aliases the source snapshot", async () => {
    const fixture = await createSourceFixture([{
      signalId: "signal-symlink-alias",
      evidenceId: "30000000-0000-4000-8000-000000000002",
      messages: [message("u1", "user", "I bought my bookshelf from IKEA.")]
    }]);
    const aliasedSourcePath = join(fixture.root, "alaya.db");
    const dataRootAlias = join(fixture.root, "data-root-alias");
    await copyFile(fixture.sourceDbPath, aliasedSourcePath);
    await symlink(fixture.root, dataRootAlias, "dir");
    const sourceBefore = await fileSha256(aliasedSourcePath);

    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: aliasedSourcePath,
      variant: "longmemeval_s",
      historyRoot: join(fixture.root, "history"),
      dataDirRoot: dataRootAlias,
      experiment: true,
      derivedEvidenceProjectionRebuild: true
    }, undefined, {})).rejects.toThrow(/source snapshot must differ|symbolic link/u);

    expect(await fileSha256(aliasedSourcePath)).toBe(sourceBefore);
    await expect(readFile(aliasedSourcePath)).resolves.toBeInstanceOf(Buffer);
  });
});

function seedFormedCapture(dbPath: string, evidenceObjectId: string): void {
  const db = initDatabase({ filename: dbPath, temporalMode: "candidate" });
  try {
    const owner = db.connection.prepare(`
      SELECT workspace_id, source_hash, excerpt FROM evidence_capsules
      WHERE object_id = ?
    `).get(evidenceObjectId) as {
      readonly workspace_id: string;
      readonly source_hash: string;
      readonly excerpt: string;
    };
    const formation = materializeEvidenceFactFrameFormation({
      sourceAssertion: owner.excerpt,
      sourceHash: owner.source_hash,
      proposal: {
        schema_version: 1,
        producer_operator_id: "test_current_schema_formation_v1",
        source_assertion: owner.excerpt,
        fact_frame: {
          schema_version: 1,
          slots: [
            { role: "subject", text: "I" },
            { role: "relation", text: "use" },
            { role: "value", text: "Atlas" }
          ]
        }
      }
    });
    db.connection.transaction(() => {
      insertFormation(db, evidenceObjectId, owner, formation);
      insertFactKeys(db, evidenceObjectId, owner, formation.searchProjections);
    })();
  } finally {
    db.close();
  }
}

function insertFormation(
  db: StorageDatabase,
  evidenceObjectId: string,
  owner: Readonly<{ workspace_id: string; source_hash: string }>,
  formation: ReturnType<typeof materializeEvidenceFactFrameFormation>
): void {
  const capture = formation.capture;
  db.connection.prepare(`
    INSERT INTO evidence_fact_frame_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status,
      producer_operator_id, source_hash, fact_frame_json, capture_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidenceObjectId, owner.workspace_id, capture.schema_version, capture.operator_id,
    capture.status, capture.producer_operator_id, capture.source_hash,
    JSON.stringify(capture.fact_frame), capture.capture_digest
  );
}

function insertFactKeys(
  db: StorageDatabase,
  evidenceObjectId: string,
  owner: Readonly<{ workspace_id: string; source_hash: string }>,
  projections: ReturnType<typeof materializeEvidenceFactFrameFormation>["searchProjections"]
): void {
  const insert = db.connection.prepare(`
    INSERT INTO evidence_search_projections (
      evidence_object_id, projection_id, projection_kind,
      workspace_id, source_hash, content
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const projection of projections) {
    insert.run(
      evidenceObjectId, projection.projection_id, projection.projection_kind,
      owner.workspace_id, owner.source_hash, projection.content
    );
  }
}

function tamperFactKeys(dbPath: string, evidenceObjectId: string): void {
  const db = initDatabase({ filename: dbPath, temporalMode: "candidate" });
  try {
    db.connection.prepare(`
      UPDATE evidence_search_projections SET content = content || ' tampered'
      WHERE evidence_object_id = ? AND projection_kind = 'fact_key'
    `).run(evidenceObjectId);
  } finally {
    db.close();
  }
}
