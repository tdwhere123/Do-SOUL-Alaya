import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryHqRepo
} from "@do-soul/alaya-storage";
import type { EvidenceCapsule } from "@do-soul/alaya-protocol";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchEdgeFormationMember
} from "../../../harness/daemon.js";
import { runAnswersWithEdges } from
  "../../../longmemeval/runner/question/runner-question.js";
import { assertSnapshotAnswersWithFormation } from
  "../../../bench/snapshot/current/snapshot-answers-with-formation.js";

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
    const members = await seedEndpoints(dbPath, workspaceId, daemon.runId);

    const formation = await runAnswersWithEdges(
      "q-embedding-disabled-formation",
      daemon,
      members
    );
    await runAnswersWithEdges("q-embedding-disabled-formation", daemon, members);

    await daemon.shutdown();
    daemon = undefined;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT projection_json
          FROM relation_path_projections
         WHERE workspace_id = ?
           AND generation = (
             SELECT active_projection_generation
               FROM temporal_schema_state
              WHERE state_id = 1 AND status = 'ready'
           )
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
      [{ workspaceId, answersWithFormation: formation }]
    )).not.toThrow();
  }, 60_000);
});

interface RelationRow {
  readonly projection_json: string;
}

function parseRelation(row: RelationRow) {
  const projection = JSON.parse(row.projection_json) as Record<string, unknown>;
  return {
    anchors: projection.anchors,
    constitution: projection.constitution,
    effect: projection.effect_vector,
    lifecycle: projection.lifecycle,
    legitimacy: projection.legitimacy
  };
}

async function seedEndpoints(
  dbPath: string,
  workspaceId: string,
  runId: string
): Promise<readonly BenchEdgeFormationMember[]> {
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
  const database = initDatabase({ filename: dbPath });
  const eventLog = new SqliteEventLogRepo(database);
  const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
  const hqRepo = new SqliteMemoryHqRepo(database);
  const insertMemory = database.connection.prepare(`INSERT INTO memory_entries (
      object_id, created_at, updated_at, created_by, dimension, source_kind,
      formation_kind, scope_class, content, workspace_id, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [index, member] of members.entries()) {
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
    const sourceEvent = await eventLog.append({
      event_type: "engine.response.received",
      entity_type: "engine_response",
      entity_id: member.memoryId,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: "test",
      payload_json: { source: "formation-fixture" }
    });
    const evidenceId = `00000000-0000-4000-8000-00000000020${index + 1}`;
    await evidenceRepo.create(evidenceCapsule({
      object_id: evidenceId,
      workspace_id: workspaceId,
      run_id: runId,
      event_anchor: {
        event_type: sourceEvent.event_type,
        event_id: sourceEvent.event_id,
        occurred_at: sourceEvent.created_at
      },
      source_hash: `sha256:${evidenceId}`,
      gist: `Answer evidence ${member.memoryId}`,
      excerpt: `Answer evidence ${member.memoryId}`
    }));
    await hqRepo.upsertFromEvidence({
      object_id: member.memoryId,
      workspace_id: workspaceId,
      hqs: ["Which European capital did the user visit during spring?"],
      evidence_id: evidenceId,
      producer_id: "formation_fixture_hq_v1",
      created_at: sourceEvent.created_at,
      updated_at: sourceEvent.created_at
    });
  }
  return members;
}

function evidenceCapsule(overrides: Partial<EvidenceCapsule>): EvidenceCapsule {
  return {
    object_id: "00000000-0000-4000-8000-000000000201",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    created_by: "bench_fixture",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: "formation fixture",
      keywords: ["capital"],
      summary: "Answer evidence"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "Answer evidence",
    excerpt: "Answer evidence",
    source_hash: "sha256:formation-fixture",
    run_id: "longmemeval-formation-ready-run",
    workspace_id: "longmemeval-formation-ready",
    surface_id: null,
    ...overrides
  };
}
