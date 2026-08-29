import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteSynthesisCapsuleRepo
} from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import {
  assertBuiltWorker,
  builtWorkerUrl,
  createEvidenceCapsule,
  createMemoryEntry,
  createSynthesisCapsule
} from "./recall-read-worker-client-fixture.js";

describe("RecallReadWorkerClient keyword-field capture", () => {
  it("keeps worker batch reads scoped to the requested workspace", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-scope-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
    const synthesisRepo = new SqliteSynthesisCapsuleRepo(database);
    const workspaceMemoryId = randomUUID();
    const otherWorkspaceMemoryId = randomUUID();
    const workspaceSynthesisId = randomUUID();
    const otherWorkspaceSynthesisId = randomUUID();
    const workspaceEvidenceId = randomUUID();
    const otherWorkspaceEvidenceId = randomUUID();

    try {
      await memoryRepo.create(createMemoryEntry({
        object_id: workspaceMemoryId,
        workspace_id: "workspace-1",
        content: "Worker recall workspace one memory",
        activation_score: 1,
        evidence_refs: [workspaceEvidenceId]
      }));
      await memoryRepo.create(createMemoryEntry({
        object_id: otherWorkspaceMemoryId,
        workspace_id: "workspace-2",
        content: "Worker recall workspace two memory",
        activation_score: 1,
        evidence_refs: [otherWorkspaceEvidenceId]
      }));
      await synthesisRepo.create(createSynthesisCapsule({
        object_id: workspaceSynthesisId,
        workspace_id: "workspace-1",
        run_id: "run-1"
      }));
      await evidenceRepo.create(createEvidenceCapsule({
        object_id: workspaceEvidenceId,
        workspace_id: "workspace-1",
        run_id: "run-1",
        artifact_ref: "doc-s1-t10"
      }));
      await evidenceRepo.create(createEvidenceCapsule({
        object_id: otherWorkspaceEvidenceId,
        workspace_id: "workspace-2",
        run_id: "run-2",
        artifact_ref: "doc-s1-t11"
      }));
      await synthesisRepo.create(createSynthesisCapsule({
        object_id: otherWorkspaceSynthesisId,
        workspace_id: "workspace-2",
        run_id: "run-2"
      }));
      database.close();

      const client = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        await expect(
          client.memoryRepo.findByIds!("workspace-1", [
            workspaceMemoryId,
            otherWorkspaceMemoryId
          ])
        ).resolves.toMatchObject([{ object_id: workspaceMemoryId }]);
        await expect(
          client.memoryRepo.findBoundEvidenceRefs!("workspace-1", [
            workspaceEvidenceId,
            otherWorkspaceEvidenceId
          ])
        ).resolves.toEqual([workspaceEvidenceId]);
        await expect(
          client.memoryRepo.searchManyByKeywordWithinObjectIds!(
            "workspace-1",
            [
              { queryText: "workspace one", limit: 5 },
              { queryText: "Worker recall", limit: 5 }
            ],
            [workspaceMemoryId, otherWorkspaceMemoryId]
          )
        ).resolves.toEqual([
          [expect.objectContaining({ object_id: workspaceMemoryId })],
          [expect.objectContaining({ object_id: workspaceMemoryId })]
        ]);
        await expect(
          client.synthesisSearchPort.findByIds("workspace-1", [
            workspaceSynthesisId,
            otherWorkspaceSynthesisId
          ])
        ).resolves.toMatchObject([{ object_id: workspaceSynthesisId }]);
        await expect(
          client.evidenceSearchPort.findSourceAnchorsByIds!("workspace-1", [
            workspaceEvidenceId,
            otherWorkspaceEvidenceId
          ])
        ).resolves.toEqual([{
          evidence_object_id: workspaceEvidenceId,
          artifact_ref: "doc-s1-t10"
        }]);
        const memoryField = await client.memoryRepo.searchByKeywordField!(
          "workspace-1", "workspace", 1, {}, [2]
        );
        expect(new Set(memoryField.lanes.flatMap((lane) =>
          lane.observations.map(({ object_id }) => object_id)
        ))).toEqual(new Set([workspaceMemoryId]));
        expect(memoryField.refinement_levels?.[0]?.requested_depth).toBe(2);
        expect(memoryField.lexical_raw_rank_receipt).toBeDefined();
        const memoryFieldWithProof = await client.memoryRepo.searchByKeywordField!(
          "workspace-1", "workspace", 1, {}, [2], { variant: "lexical_relaxed" }
        );
        expect(memoryFieldWithProof.lexical_raw_rank_receipt).toBeDefined();
        expect(memoryFieldWithProof.refinement_levels?.[0])
          .not.toHaveProperty("lexical_raw_rank_receipt");
        const evidenceField = await client.evidenceSearchPort.searchByKeywordField!(
          "workspace-1", "worker", 1, [2]
        );
        expect(new Set(evidenceField.lanes.flatMap((lane) =>
          lane.observations.map(({ object_id }) => object_id)
        ))).toEqual(new Set([workspaceEvidenceId]));
        expect(evidenceField.refinement_levels?.[0]?.requested_depth).toBe(2);
        const synthesisField = await client.synthesisSearchPort.searchByKeywordField!(
          "workspace-1", "synthesis", 1, [2]
        );
        expect(new Set(synthesisField.lanes.flatMap((lane) =>
          lane.observations.map(({ object_id }) => object_id)
        ))).toEqual(new Set([workspaceSynthesisId]));
        expect(synthesisField.refinement_levels?.[0]?.requested_depth).toBe(2);
      } finally {
        await client.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
