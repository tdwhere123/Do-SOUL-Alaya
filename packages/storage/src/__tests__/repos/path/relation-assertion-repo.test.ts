import { afterEach, describe, expect, it } from "vitest";
import type { PathRelation } from "@do-soul/alaya-protocol";
import { SqliteRelationAssertionRepo } from "../../../repos/path/relation-assertion-repo.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo
} from "../capsules/evidence-capsule-repo-fixture.js";
import {
  createPathRelationFixture,
  createRepo,
  trackedDatabases
} from "./path-relation-repo-fixture.js";

const asOf = "2026-07-17T01:30:00.000Z";
const currentHistoryDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const staleHistoryDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(() => {
  for (const database of trackedDatabases) {
    database.close();
  }
  trackedDatabases.clear();
});

describe("SqliteRelationAssertionRepo", () => {
  it("verifies multiple evidence anchors with one batched lookup", async () => {
    const { database, repo: evidenceRepo } = await createEvidenceCapsuleRepo();
    trackedDatabases.add(database);
    const repo = new SqliteRelationAssertionRepo(database);
    const sourceAnchor = {
      eventType: "engine.response.received",
      eventId: "evt_1",
      occurredAt: "2026-03-20T00:00:00.000Z"
    };
    const firstEvidenceId = "f6c1b587-be07-4410-b2ca-8bfbc4d82db4";
    const secondEvidenceId = "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab";

    await evidenceRepo.create(createEvidenceCapsule({ object_id: firstEvidenceId }));
    await evidenceRepo.create(createEvidenceCapsule({ object_id: secondEvidenceId }));

    expect(() => repo.assertEvidenceAnchorsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceIds: [firstEvidenceId, secondEvidenceId],
      sourceAnchor
    })).not.toThrow();
  });

  it("rejects batched evidence anchor verification when any id is outside the workspace", async () => {
    const { database, repo: evidenceRepo } = await createEvidenceCapsuleRepo();
    trackedDatabases.add(database);
    const repo = new SqliteRelationAssertionRepo(database);
    const sourceAnchor = {
      eventType: "engine.response.received",
      eventId: "evt_1",
      occurredAt: "2026-03-20T00:00:00.000Z"
    };
    const workspaceEvidenceId = "f6c1b587-be07-4410-b2ca-8bfbc4d82db4";
    const foreignEvidenceId = "256a7ff5-6150-4a82-9a53-99dbfd08cb77";

    await evidenceRepo.create(createEvidenceCapsule({ object_id: workspaceEvidenceId }));
    await evidenceRepo.create(createEvidenceCapsule({
      object_id: foreignEvidenceId,
      workspace_id: "workspace-2",
      run_id: "run-3"
    }));

    expect(() => repo.assertEvidenceAnchorsInCurrentTransaction({
      workspaceId: "workspace-1",
      evidenceIds: [workspaceEvidenceId, foreignEvidenceId],
      sourceAnchor
    })).toThrow(/Evidence 256a7ff5-6150-4a82-9a53-99dbfd08cb77 is not available in the assertion workspace\./);
  });

  it("binds an exact as-of read to the current verified history generation", async () => {
    const { database } = createRepo();
    const repo = new SqliteRelationAssertionRepo(database);
    const stalePath = createPathRelationFixture({
      path_id: "path-stale",
      created_at: asOf,
      updated_at: asOf
    });
    const currentPath = createPathRelationFixture({
      path_id: "path-current",
      created_at: asOf,
      updated_at: asOf
    });

    insertAssertion(database.connection, "assertion-stale", "event-stale", "identity-stale");
    insertAssertion(database.connection, "assertion-current", "event-current", "identity-current");
    insertGeneration(database.connection, {
      generation: "temporal-z-stale",
      historyDigest: staleHistoryDigest
    });
    insertGeneration(database.connection, {
      generation: "temporal-a-current",
      historyDigest: currentHistoryDigest
    });
    insertProjection(database.connection, "temporal-z-stale", "assertion-stale", stalePath);
    insertProjection(database.connection, "temporal-a-current", "assertion-current", currentPath);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET history_digest = ?
      WHERE state_id = 1
    `).run(currentHistoryDigest);

    await expect(repo.findProjectionByWorkspaceAtAsOf("workspace-1", asOf))
      .resolves.toEqual([currentPath]);
  });
});

function insertAssertion(
  connection: { prepare(sql: string): { run(...params: readonly unknown[]): unknown } },
  assertionId: string,
  eventId: string,
  identityKey: string
): void {
  connection.prepare(`
    INSERT INTO relation_assertions (
      assertion_id, workspace_id, admission_event_id, identity_key,
      anchors_json, relation_kind, validity_json, admitted_at
    ) VALUES (?, 'workspace-1', ?, ?, ?, 'supports', ?, ?)
  `).run(
    assertionId,
    eventId,
    identityKey,
    JSON.stringify({
      source_anchor: { kind: "object", object_id: "object-1" },
      target_anchor: { kind: "object", object_id: "object-2" }
    }),
    JSON.stringify({ kind: "open", valid_from: asOf }),
    asOf
  );
}

function insertGeneration(
  connection: { prepare(sql: string): { run(...params: readonly unknown[]): unknown } },
  input: Readonly<{ readonly generation: string; readonly historyDigest: string }>
): void {
  connection.prepare(`
    INSERT INTO temporal_projection_generations (
      generation, assertion_schema_generation, assertion_event_contract_generation,
      projection_schema_generation, projection_policy_id, projection_policy_sha256,
      history_digest, as_of, projection_count, projection_digest, status,
      created_at, verified_at
    ) VALUES (?, 'relation_assertion_v1', 'relation_assertion_event_v1',
      'relation_path_projection_v1', 'relation-path-projection-v1', 'fixture-policy',
      ?, ?, 1, ?, 'verified', ?, ?)
  `).run(
    input.generation,
    input.historyDigest,
    asOf,
    `${input.generation}-digest`,
    asOf,
    asOf
  );
}

function insertProjection(
  connection: { prepare(sql: string): { run(...params: readonly unknown[]): unknown } },
  generation: string,
  assertionId: string,
  path: PathRelation
): void {
  connection.prepare(`
    INSERT INTO relation_path_projections (
      generation, path_id, assertion_id, workspace_id, projection_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(generation, path.path_id, assertionId, path.workspace_id, JSON.stringify(path));
}
