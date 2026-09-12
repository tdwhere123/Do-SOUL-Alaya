import { expect, it, vi } from "vitest";
import { formatVerifiedUserAssertionSourceHash } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER } from
  "../../../memory/fact-frame-formation/declarative-normalizer.js";
import { createRecallRealStorage } from "../../shared/real-sqlite.test-support.js";
import { createEvidenceInput } from "../evidence-service-fixture.js";

it("stores lexical have and the full value meaning instead of inheriting a partial child identity", async () => {
  const { database, evidenceCapsuleRepo } = await createRecallRealStorage(() => undefined);
  try {
    const source = "I have more important things to do with my time.";
    const service = new EvidenceService({
      evidenceCapsuleRepo, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: vi.fn() },
      factFrameProposalNormalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
    });
    const created = await service.create(createEvidenceInput({ excerpt: source,
      source_hash: formatVerifiedUserAssertionSourceHash("b".repeat(64))
    }), [], undefined, {
      schema_version: 1, producer_operator_id: "garden_source_bound_open_semantic_factor_v3",
      source_text: source, graph: { schema_version: 2, source_kind: "evidence",
        factors: [
          { factor_id: "have", surface: "have", semantic_identity: "have", source_occurrence: 0 },
          { factor_id: "things", surface: "more important things", semantic_identity: "important things", source_occurrence: 0 }
        ], variables: [], result_variable_ids: [], propositions: [{ proposition_id: "p",
          predicate_factor_id: "have", arguments: [{ position: 0, binding_identity: "object",
            reference_kind: "factor", reference_id: "things" }] }]
      }
    });
    expect(await evidenceCapsuleRepo.findById(created.object_id)).toMatchObject({ excerpt: source });
    const fact = database.connection.prepare("SELECT fact_frame_json FROM evidence_fact_frame_formations WHERE evidence_object_id = ?")
      .get(created.object_id) as { fact_frame_json: string };
    expect(JSON.parse(fact.fact_frame_json).slots).toEqual([
      { role: "subject", text: "I" }, { role: "relation", text: "have" },
      { role: "value", text: "more important things to do with my time" }
    ]);
    const semantic = database.connection.prepare("SELECT graph_json FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?")
      .get(created.object_id) as { graph_json: string };
    expect(JSON.parse(semantic.graph_json).factors).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "more important things to do with my time",
        semantic_identity: "more important things to do with my time" })
    ]));
  } finally { database.close(); }
});
