import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FormationKind, MemoryDimension, ScopeClass, SourceKind } from "@do-soul/alaya-protocol";
import { initDatabase, readObjectKeyEvidenceSources, scanObjectKeyRetrofitSources,
  SqliteEventLogRepo, SqliteMemoryObjectKeyRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { EvidenceService } from "../../memory/evidence-service.js";
import { MemoryService } from "../../memory/memory-service.js";
import { createMemoryObjectKeyWriter } from "../../memory/object-keys/write-service.js";
import { retrofitMemoryObjectKeys } from "../../memory/object-keys/retrofit/retrofit.js";
import { createRecallRealStorage } from "../shared/real-sqlite.test-support.js";
import { createEvidenceInput } from "./evidence-service-fixture.js";

it("reuses scoped source gist for object-key writing and retrofit after reopen", async () => {
  const source = "I can enter the lab without a badge.";
  const directory = mkdtempSync(join(tmpdir(), "alaya-object-key-source-"));
  const filename = join(directory, "source.sqlite");
  const { database, evidenceCapsuleRepo, memoryEntryRepo } = await createRecallRealStorage(() => undefined, filename);
  try {
    const evidence = new EvidenceService({ evidenceCapsuleRepo, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: async () => undefined } });
    const capsule = await evidence.create(createEvidenceInput({ excerpt: source, gist: "Golden Retriever",
      source_hash: "sha256:historical-source" }));
    const service = new MemoryService({ evidenceService: { findById: (id) => evidenceCapsuleRepo.findById(id),
      findByIds: (workspace, ids) => evidenceCapsuleRepo.findByIds(workspace, ids) },
      eventLogRepo: new SqliteEventLogRepo(database), memoryEntryRepo,
      runtimeNotifier: { notifyEntry: async () => undefined } });
    const memory = await service.create({ created_by: "user_action", dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER, formation_kind: FormationKind.EXPLICIT, scope_class: ScopeClass.PROJECT,
      content: "A visit is planned.", domain_tags: [], evidence_refs: [capsule.object_id],
      workspace_id: "workspace-1", run_id: "run-1", surface_id: null });
    database.close();
    const reopened = initDatabase({ filename });
    try {
      const keys = new SqliteMemoryObjectKeyRepo(reopened);
      const writer = createMemoryObjectKeyWriter({ readEvidenceSources: (workspace, ids) =>
        readObjectKeyEvidenceSources(reopened, workspace, ids), replaceOwnerKeys: (workspace, owner, minted, expected) =>
        keys.replaceOwnerKeys(workspace, owner, minted, expected) });
      writer.materializeForMemory(memory);
      const minted = keys.listByOwner(memory.workspace_id, memory.object_id);
      expect(minted.some(({ key_type }) => key_type === "gist_remainder")).toBe(true);
      const scan = scanObjectKeyRetrofitSources(reopened);
      expect(scan.owners.map(({ object_id }) => object_id)).toContain(memory.object_id);
      retrofitMemoryObjectKeys({ ...scan, replaceOwnerKeys: (workspace, owner, values, expected) => keys.replaceOwnerKeys(workspace, owner, values, expected) });
      expect(keys.listByOwner(memory.workspace_id, memory.object_id)).toEqual(minted);
      expect((await new SqliteEvidenceCapsuleRepo(reopened).findById(capsule.object_id))?.excerpt).toBe(source);
    } finally { reopened.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
