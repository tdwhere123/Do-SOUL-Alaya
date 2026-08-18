import { afterEach, describe, expect, it } from "vitest";
import type { MemoryHqRepo } from "../../../repos/memory/memory-hq-repo.js";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { SqliteRelationAssertionRepo } from "../../../repos/path/relation-assertion-repo.js";
import { createEvidenceCapsule } from "../capsules/evidence-capsule-repo-fixture.js";
import {
  createEmbeddingRecord,
  createRepoContext,
  getColumnNames,
  trackedDatabases
} from "./memory-embedding-repo-fixture.js";

const databases = trackedDatabases;
const MEM_A = "11111111-1111-4111-8111-111111111111";
const MEM_B = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-04-23T00:00:00.000Z";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

async function createHqRepo(database: Parameters<typeof getColumnNames>[0]): Promise<MemoryHqRepo> {
  const storage = (await import("../../../index.js")) as Record<string, unknown>;
  expect(storage.SqliteMemoryHqRepo).toBeTypeOf("function");
  const Ctor = storage.SqliteMemoryHqRepo as new (db: typeof database) => MemoryHqRepo;
  return new Ctor(database);
}
async function seedHqEvidence(
  database: Parameters<typeof getColumnNames>[0],
  evidenceId: string,
  entityId: string
) {
  const sourceEvent = await new SqliteEventLogRepo(database).append({
    event_type: "engine.response.received",
    entity_type: "engine_response",
    entity_id: entityId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    caused_by: "test",
    payload_json: { source: "test" }
  });
  const receipt = evidenceReceipt(evidenceId, sourceEvent.event_id);
  await new SqliteEvidenceCapsuleRepo(database).create(createEvidenceCapsule({
    object_id: evidenceId,
    event_anchor: receipt.source_event_anchor
  }));
  return receipt;
}

function evidenceReceipt(evidenceId: string, eventId: string) {
  return {
    evidence_id: evidenceId,
    source_event_anchor: {
      event_type: "engine.response.received" as const,
      event_id: eventId,
      occurred_at: NOW
    }
  };
}

function hqFormationReceipt(observationId: string, observationSha256: string) {
  return {
    operator_id: "memory_hq_repo_test_v1",
    operator_sha256: "a".repeat(64),
    parameters: {},
    parameter_sha256: "b".repeat(64),
    source_observations: [{
      source_kind: "memory_hq_observation" as const,
      source_id: observationId,
      source_sha256: observationSha256
    }],
    decision: {},
    decision_sha256: "c".repeat(64)
  };
}


describe("Memory HQ storage repo", () => {
  it("persists current and immutable observation columns", async () => {
    const { database } = await createRepoContext();

    const versions = database.connection
      .prepare("SELECT MAX(version) AS version FROM schema_version")
      .all() as ReadonlyArray<{ readonly version: number }>;

    expect(versions.map((entry) => entry.version)).toEqual([8]);
    expect(getColumnNames(database, "memory_hq")).toEqual([
      "object_id",
      "workspace_id",
      "hqs_json",
      "created_at",
      "updated_at",
      "observation_id"
    ]);
    expect(getColumnNames(database, "memory_hq_observations")).toEqual([
      "observation_id",
      "object_id",
      "workspace_id",
      "evidence_id",
      "source_event_type",
      "source_event_id",
      "source_occurred_at",
      "producer_id",
      "hqs_json",
      "hq_content_sha256",
      "observation_sha256",
      "recorded_at"
    ]);
  });

  it("round-trips an immutable, EventLog-grounded HQ observation", async () => {
    const { database, workspaceId } = await createRepoContext();
    const repo = await createHqRepo(database);
    const receipt = await seedHqEvidence(database, "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9", "response-a");

    const written = await repo.upsert({
      object_id: MEM_A,
      workspace_id: workspaceId,
      hqs: ["What workflow is pinned?", "Which repository?"],
      evidence_receipt: receipt,
      producer_id: "test_hq_producer_v1",
      created_at: NOW,
      updated_at: NOW
    });

    const observations = await repo.getObservationsByObjectIds([MEM_A, MEM_B]);
    expect(observations.get(MEM_A)).toEqual(written);
    expect(written.observation_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => new SqliteRelationAssertionRepo(database).assertFormationInputsInCurrentTransaction({
      workspaceId,
      evidenceReceipts: [receipt],
      formationReceipt: hqFormationReceipt(written.observation_id, written.observation_sha256)
    })).not.toThrow();
    expect(observations.has(MEM_B)).toBe(false);
  });

  it("retains prior observations when the current HQ projection changes", async () => {
    const { database, workspaceId } = await createRepoContext();
    const repo = await createHqRepo(database);
    const receipt = await seedHqEvidence(database, "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9", "response-a");
    const common = {
      object_id: MEM_A,
      workspace_id: workspaceId,
      evidence_receipt: receipt,
      producer_id: "test_hq_producer_v1",
      created_at: NOW,
      updated_at: NOW
    };

    const first = await repo.upsert({ ...common, hqs: ["old"] });
    const second = await repo.upsert({ ...common, hqs: ["new one", "new two"] });

    const observations = await repo.getObservationsByObjectIds([MEM_A]);
    expect(observations.get(MEM_A)).toEqual(second);
    expect(first.observation_id).not.toBe(second.observation_id);
    expect(database.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_hq_observations WHERE object_id = ?"
    ).get(MEM_A)).toEqual({ count: 2 });
  });

  it("fails closed for Evidence whose source EventLog entry is unavailable", async () => {
    const { database, workspaceId } = await createRepoContext();
    const repo = await createHqRepo(database);
    const evidenceId = "95b3671a-d8d8-4848-9e5c-07d0a89f5ae9";
    const receipt = evidenceReceipt(evidenceId, "missing-event");
    await new SqliteEvidenceCapsuleRepo(database).create(createEvidenceCapsule({
      object_id: evidenceId,
      event_anchor: receipt.source_event_anchor
    }));

    await expect(repo.upsert({
      object_id: MEM_A,
      workspace_id: workspaceId,
      hqs: ["unwitnessed"],
      evidence_receipt: receipt,
      producer_id: "test_hq_producer_v1",
      created_at: NOW,
      updated_at: NOW
    })).rejects.toThrow(/source EventLog entry is unavailable/);
  });

  it("isolates cosine spaces: schema_version filter never mixes d2q and non-d2q vectors", async () => {
    const { workspaceId, repo: embeddingRepo } = await createRepoContext();

    await embeddingRepo.upsert(
      createEmbeddingRecord({ object_id: MEM_A, workspace_id: workspaceId, schema_version: 1 })
    );
    await embeddingRepo.upsert(
      createEmbeddingRecord({ object_id: MEM_B, workspace_id: workspaceId, schema_version: 2 })
    );

    const d2q = await embeddingRepo.listByWorkspace(workspaceId, { schemaVersion: 2 });
    const nonD2q = await embeddingRepo.listByWorkspace(workspaceId, { schemaVersion: 1 });

    expect(d2q.map((record) => record.object_id)).toEqual([MEM_B]);
    expect(nonD2q.map((record) => record.object_id)).toEqual([MEM_A]);
  });
});
