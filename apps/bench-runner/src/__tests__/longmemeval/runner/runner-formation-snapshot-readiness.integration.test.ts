import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchEdgeFormationMember
} from "../../../harness/daemon.js";
import { runAnswersWithEdges } from
  "../../../longmemeval/runner/question/runner-question.js";
import { assertSnapshotAnswersWithFormation } from
  "../../../longmemeval/snapshot/current/snapshot-answers-with-formation.js";

let daemon: BenchDaemonHandle | undefined;
let root: string | undefined;

afterEach(async () => {
  await daemon?.shutdown().catch(() => undefined);
  daemon = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("embedding-disabled runner formation to snapshot readiness", () => {
  it("persists one governed answers_with relation when formation repeats", async () => {
    root = await mkdtemp(join(tmpdir(), "longmemeval-formation-ready-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "longmemeval-formation-ready",
      runId: "longmemeval-formation-ready-run",
      embeddingMode: "disabled",
      reviewerIdentity: "user:test",
      reviewerToken: "test-token"
    });
    const dbPath = join(daemon.dataDir, "alaya.db");
    const workspaceId = daemon.workspaceId;
    const members = seedEndpoints(dbPath, workspaceId, daemon.runId);

    await runAnswersWithEdges("q-embedding-disabled-formation", daemon, members);
    await runAnswersWithEdges("q-embedding-disabled-formation", daemon, members);

    await daemon.shutdown();
    daemon = undefined;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT anchors_json, constitution_json, effect_vector_json,
               lifecycle_json, legitimacy_json
          FROM path_relations
         WHERE workspace_id = ?
      `).all(workspaceId) as unknown as RelationRow[];
      expect(rows).toHaveLength(1);
      expect(parseRelation(rows[0]!)).toMatchObject({
        anchors: {
          source_anchor: { kind: "object", object_id: expect.any(String) },
          target_anchor: { kind: "object", object_id: expect.any(String) }
        },
        constitution: { relation_kind: "answers_with" },
        effect: { recall_bias: expect.toSatisfy((value: number) => value > 0) },
        lifecycle: { status: "active" },
        legitimacy: {
          governance_class: "recall_allowed",
          evidence_basis: expect.toSatisfy(
            (value: unknown[]) => Array.isArray(value) && value.length > 0
          )
        }
      });
    } finally {
      db.close();
    }
    expect(() => assertSnapshotAnswersWithFormation(
      dbPath,
      [workspaceId]
    )).not.toThrow();
  }, 60_000);
});

interface RelationRow {
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
}

function parseRelation(row: RelationRow) {
  return {
    anchors: JSON.parse(row.anchors_json),
    constitution: JSON.parse(row.constitution_json),
    effect: JSON.parse(row.effect_vector_json),
    lifecycle: JSON.parse(row.lifecycle_json),
    legitimacy: JSON.parse(row.legitimacy_json)
  };
}

function seedEndpoints(
  dbPath: string,
  workspaceId: string,
  runId: string
): readonly BenchEdgeFormationMember[] {
  const members = [
    {
      memoryId: "00000000-0000-4000-8000-000000000101",
      sessionId: "session-paris",
      formationKey: "2026-04-01T00:00:00.000Z|0001"
    },
    {
      memoryId: "00000000-0000-4000-8000-000000000102",
      sessionId: "session-lisbon",
      formationKey: "2026-05-01T00:00:00.000Z|0001"
    }
  ] satisfies readonly BenchEdgeFormationMember[];
  const db = new DatabaseSync(dbPath);
  try {
    const insertMemory = db.prepare(`INSERT INTO memory_entries (
      object_id, created_at, updated_at, created_by, dimension, source_kind,
      formation_kind, scope_class, content, workspace_id, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertHq = db.prepare(`INSERT INTO memory_hq (
      object_id, workspace_id, hqs_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`);
    for (const member of members) {
      insertMemory.run(
        member.memoryId,
        "2026-07-30T00:00:00.000Z",
        "2026-07-30T00:00:00.000Z",
        "system",
        "procedure",
        "user",
        "explicit",
        "project",
        `Answer memory ${member.memoryId}`,
        workspaceId,
        runId
      );
      insertHq.run(
        member.memoryId,
        workspaceId,
        JSON.stringify([
          "Which European capital did the user visit during spring?"
        ]),
        "2026-07-30T00:00:00.000Z",
        "2026-07-30T00:00:00.000Z"
      );
    }
  } finally {
    db.close();
  }
  return members;
}
