import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalGovernanceSubject } from "@do-soul/alaya-protocol";
import { encodeAuthorizedScopesAdmission, snapshotIdFromPin } from "@do-soul/alaya-core";
import { initDatabase, prepareIndexedRecallProjection, SqliteClaimFormRepo, SqliteMemoryEntryRepo, SqliteIndexedRecallProjection } from "@do-soul/alaya-storage";
import { createBoundedActiveConstraintsReader } from "../../../runtime/recall-read-worker/active-constraints.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { assertBuiltWorker, builtWorkerUrl, createMemoryEntry } from "./recall-read-worker-client-fixture.js";

describe("bounded active constraints native and worker binding", () => {
  it("returns the same real positive constraint and refuses a stale pin in both routes", async () => {
    assertBuiltWorker();
    const root = mkdtempSync(join(tmpdir(), "alaya-bounded-constraints-"));
    const database = initDatabase({ filename: join(root, "alaya.db") });
    let client: ReturnType<typeof createRecallReadWorkerClient> = null;
    try {
      const objectId = "8d77b8d4-2291-4b27-a243-d1168a68e97b";
      await new SqliteMemoryEntryRepo(database).create(createMemoryEntry({
        object_id: objectId, workspace_id: "workspace-1", content: "Always retain the audit trail.", activation_score: 0
      }));
      new SqliteClaimFormRepo(database).create({
        object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a", object_kind: "claim_form", schema_version: 1,
        lifecycle_state: "active", created_at: "2026-06-17T00:00:00.000Z", updated_at: "2026-06-17T00:00:00.000Z",
        created_by: "user", governance_subject: canonicalGovernanceSubject("audit", { retention: "required" }),
        claim_kind: "constraint", scope_class: "project", enforcement_level: "strict", origin_tier: "user_explicit",
        precedence_basis: "authority", proposition_digest: "Retain audit trail", evidence_refs: [],
        source_object_refs: [objectId], workspace_id: "workspace-1", claim_status: "active"
      });
      prepareIndexedRecallProjection(database);
      const request = {
        workspaceId: "workspace-1", asOf: "2026-06-18T00:00:00.000Z", nativeLimit: 128, byteLimit: 65536,
        authorizedScopes: { mode: "unrestricted" as const },
        snapshotId: snapshotIdFromPin("workspace-1", new SqliteIndexedRecallProjection(database.connection).observablePin("workspace-1"))
      };
      const direct = createBoundedActiveConstraintsReader(database);
      const result = direct(request);
      expect(result).toMatchObject({ total_count: 1, completeness: "complete", constraints: [{ object_id: objectId }] });
      expect(() => direct({ ...request, snapshotId: "stale" })).toThrow(/snapshot mismatch/u);
      const { snapshotId: _expectedPin, ...discovery } = request;
      expect(direct(discovery)).toEqual(result);
      database.close();
      client = createRecallReadWorkerClient({ databaseFilename: database.filename, workerUrl: builtWorkerUrl, workerCount: 1 });
      expect(client).not.toBeNull();
      await client!.ready();
      await expect(client!.activeConstraintsPort.readBounded!(request)).resolves.toEqual(result);
      await expect(client!.activeConstraintsPort.readBounded!(discovery)).resolves.toEqual(result);
      await expect(client!.activeConstraintsPort.readBounded!({
        ...discovery, authorizedScopes: { mode: "named", scopes: ["global_core"] }
      })).resolves.toMatchObject({
        constraints: [], total_count: 0, completeness: "complete",
        binding: { authorized_scopes: { mode: "named", scopes: ["global_core"] } }
      });
      await expect(client!.activeConstraintsPort.readBounded!({ ...request, snapshotId: "stale" }))
        .rejects.toThrow(/snapshot mismatch/u);
      await expect(client!.activeConstraintsPort.readBounded!({ ...request, nativeLimit: 4 }))
        .resolves.toMatchObject({ total_count: null, completeness: "incomplete" });
      await expect(client!.activeConstraintsPort.readBounded!({ ...discovery, nativeLimit: 3 }))
        .resolves.toMatchObject({ total_count: null, completeness: "incomplete", work: { native_visits: 3 } });
    } finally {
      await client?.close();
      if (!database.isClosed()) database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("agrees with observation tri-state for a global_core constraint", async () => {
    assertBuiltWorker();
    const root = mkdtempSync(join(tmpdir(), "alaya-scope-matrix-"));
    const database = initDatabase({ filename: join(root, "alaya.db") });
    let client: ReturnType<typeof createRecallReadWorkerClient> = null;
    try {
      const objectId = "8d77b8d4-2291-4b27-a243-d1168a68e97c";
      await new SqliteMemoryEntryRepo(database).create({
        ...createMemoryEntry({
          object_id: objectId, workspace_id: "workspace-1", content: "Global core rule.", activation_score: 0
        }),
        scope_class: "global_core"
      });
      new SqliteClaimFormRepo(database).create({
        object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96b", object_kind: "claim_form", schema_version: 1,
        lifecycle_state: "active", created_at: "2026-06-17T00:00:00.000Z", updated_at: "2026-06-17T00:00:00.000Z",
        created_by: "user", governance_subject: canonicalGovernanceSubject("audit", { retention: "required" }),
        claim_kind: "constraint", scope_class: "global_core", enforcement_level: "strict", origin_tier: "user_explicit",
        precedence_basis: "authority", proposition_digest: "Global core rule", evidence_refs: [],
        source_object_refs: [objectId], workspace_id: "workspace-1", claim_status: "active"
      });
      prepareIndexedRecallProjection(database);
      const snapshotId = snapshotIdFromPin(
        "workspace-1",
        new SqliteIndexedRecallProjection(database.connection).observablePin("workspace-1")
      );
      const reader = createBoundedActiveConstraintsReader(database);
      const cases: ReadonlyArray<{
        readonly authorized_scopes: readonly string[] | null | undefined;
        readonly visible: boolean;
      }> = [
        { authorized_scopes: null, visible: true },
        { authorized_scopes: undefined, visible: false },
        { authorized_scopes: [], visible: false },
        { authorized_scopes: ["project"], visible: false }
      ];
      for (const entry of cases) {
        const admission = encodeAuthorizedScopesAdmission(entry.authorized_scopes);
        const direct = reader({
          workspaceId: "workspace-1", asOf: "2026-06-18T00:00:00.000Z",
          nativeLimit: 128, byteLimit: 65536, snapshotId, authorizedScopes: admission
        });
        expect(direct.constraints.map((row) => row.object_id).includes(objectId)).toBe(entry.visible);
        expect(direct.binding.authorized_scopes).toEqual(admission);
      }
      database.close();
      client = createRecallReadWorkerClient({ databaseFilename: database.filename, workerUrl: builtWorkerUrl, workerCount: 1 });
      expect(client).not.toBeNull();
      await client!.ready();
      for (const entry of cases) {
        const admission = encodeAuthorizedScopesAdmission(entry.authorized_scopes);
        const result = await client!.activeConstraintsPort.readBounded!({
          workspaceId: "workspace-1", asOf: "2026-06-18T00:00:00.000Z",
          nativeLimit: 128, byteLimit: 65536, authorizedScopes: admission
        });
        expect(result.constraints.map((row) => row.object_id).includes(objectId)).toBe(entry.visible);
      }
    } finally {
      await client?.close();
      if (!database.isClosed()) database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
