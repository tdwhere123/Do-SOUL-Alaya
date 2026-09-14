import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatVerifiedUserAssertionSourceHash,
  OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION
} from "@do-soul/alaya-protocol";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER as normalizer } from "@do-soul/alaya-protocol/node/source-frame";
import { SqliteEventLogRepo, readObjectKeyEvidenceSources } from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { createRecallRealStorage } from "../../shared/real-sqlite.test-support.js";
import { createEvidenceInput } from "../evidence-service-fixture.js";

const sourceHash = formatVerifiedUserAssertionSourceHash("b".repeat(64));

describe("independent source formation", () => {
  it.each(["missing", "rejected"] as const)(
    "forms qualified source despite %s nomination and retains both after reopen",
    async (nomination) => {
      const directory = mkdtempSync(join(tmpdir(), "source-formation-"));
      const filename = join(directory, "source.db");
      const source = "I bought tea.";
      let storage = await createRecallRealStorage(() => undefined, filename);
      try {
        const service = new EvidenceService({
          evidenceCapsuleRepo: storage.evidenceCapsuleRepo,
          eventLogRepo: new SqliteEventLogRepo(storage.database),
          runtimeNotifier: { notifyEntry: () => undefined },
          factFrameProposalNormalizer: normalizer
        });
        const created = await service.create(createEvidenceInput({ excerpt: source, source_hash: sourceHash }), [],
          undefined, nomination === "rejected" ? OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION : undefined);
        storage.database.close();
        storage = await createRecallRealStorage(() => undefined, filename);
        const retained = await storage.evidenceCapsuleRepo.findById(created.object_id);
        expect(retained).toMatchObject({ excerpt: source });
        const row = storage.database.connection.prepare(`SELECT semantic_completeness_json,
          graph_json, status FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?`)
          .get(created.object_id) as { semantic_completeness_json: string; graph_json: string; status: string };
        const receipt = JSON.parse(row.semantic_completeness_json);
        expect(row.status).toBe("formed");
        expect(receipt).toMatchObject({ status: "certified", operator_id: "evidence_osf_semantic_completeness_v3",
          upstream_semantic_formation: { status: nomination === "missing" ? "unavailable" : "rejected", graph: null } });
        expect(JSON.parse(row.graph_json).factors).toEqual([
          { factor_id: "argument_0", surface: "I", semantic_identity: "i", source_span: [0, 1] },
          { factor_id: "predicate", surface: "bought", semantic_identity: "bought", source_span: [2, 8] },
          { factor_id: "argument_1", surface: "tea", semantic_identity: "tea", source_span: [9, 12] }
        ]);
        // The qualified reader must expose the independently produced graph, not only its SQL row.
        expect(readObjectKeyEvidenceSources(storage.database, "workspace-1", [created.object_id])[0]?.osf_graph)
          .toEqual(JSON.parse(row.graph_json));
      } finally {
        storage.database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["I can enter the lab only if I have a badge.", "Alice Smith likes tea."])(
    "retains unsupported source without manufacturing semantic formation: %s", async (source) => {
      const directory = mkdtempSync(join(tmpdir(), "unsupported-source-"));
      const filename = join(directory, "source.db");
      let storage = await createRecallRealStorage(() => undefined, filename);
      try {
        const service = new EvidenceService({ evidenceCapsuleRepo: storage.evidenceCapsuleRepo,
          eventLogRepo: new SqliteEventLogRepo(storage.database), runtimeNotifier: { notifyEntry: () => undefined },
          factFrameProposalNormalizer: normalizer });
        const created = await service.create(createEvidenceInput({ excerpt: source, source_hash: sourceHash }));
        storage.database.close();
        storage = await createRecallRealStorage(() => undefined, filename);
        expect(await storage.evidenceCapsuleRepo.findById(created.object_id)).toMatchObject({ excerpt: source });
        const row = storage.database.connection.prepare("SELECT status FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?")
          .get(created.object_id);
        expect(row).toEqual({ status: "unavailable" });
        expect(readObjectKeyEvidenceSources(storage.database, "workspace-1", [created.object_id])[0]?.osf_graph).toBeNull();
      } finally {
        storage.database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
