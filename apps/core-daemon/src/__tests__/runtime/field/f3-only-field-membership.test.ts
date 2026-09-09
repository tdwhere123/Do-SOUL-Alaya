import { describe, expect, it, vi } from "vitest";
import { EvidenceService, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteEvidenceCapsuleRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { CLOCK, EVIDENCE_ID, WORKSPACE_ID, composeField, createPlantedHarness } from "./source-field-harness.js";

const planted = createPlantedHarness();
const EXCERPT = "I completed Sichuan recipes last autumn";
const F3_IDENTITY = "learn cook";
const SOURCE_SURFACE = "completed";

describe("source-bound semantic factor publication", () => {
  it("persists supplied F3 source identity without a query-time provider or ranker", async () => {
    const database = planted.openMemoryDatabase();
    const field = composeField(database);
    await createF3Evidence(database, field);
    expect((await new SqliteEvidenceCapsuleRepo(database).findById(EVIDENCE_ID))?.excerpt).toBe(EXCERPT);
    const descriptors = field.fieldRepos.factors.listDescriptors(WORKSPACE_ID);
    expect(descriptors.some((row) => row.family === "f3" && row.canonical_payload?.includes(F3_IDENTITY))).toBe(true);
    const ids = new Set(descriptors.filter((row) => row.family === "f3").map((row) => row.factor_id));
    expect(field.fieldRepos.factors.listIncidences(WORKSPACE_ID).some((row) => ids.has(row.factor_id))).toBe(true);
  });
});

async function createF3Evidence(
  database: Parameters<typeof composeField>[0],
  field: ReturnType<typeof composeField>
): Promise<void> {
  const extract = vi.fn(async () => {
    throw new Error("provider must not run during source formation");
  });
  const service = new EvidenceService({
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: vi.fn() },
    generateObjectId: () => EVIDENCE_ID,
    now: () => CLOCK,
    sha256: fieldContractSha256,
    fieldStores: field.stores,
    semanticExtractor: {
      operator_id: "structured_open_semantic_factor_v1",
      extract
    }
  });
  await service.create({
    created_by: "system",
    evidence_kind: "user_statement",
    semantic_anchor: {
      topic: "notes",
      keywords: ["notes"],
      summary: "Autumn notes"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "Autumn notes",
    excerpt: EXCERPT,
    source_hash: "sha256:source-bound-f3-fixture",
    run_id: "run-1",
    workspace_id: WORKSPACE_ID,
    surface_id: null
  }, [], sourceFactFrameProposal(), sourceSemanticProposal());
  expect(extract).not.toHaveBeenCalled();
}

function sourceSemanticProposal() {
  return {
    schema_version: 1 as const,
    producer_operator_id: "open-factor-test-producer-v1",
    source_text: EXCERPT,
    graph: {
      schema_version: 2 as const,
      source_kind: "evidence" as const,
      factors: [
        { factor_id: "subject", surface: "I", source_occurrence: 0,
          semantic_identity: "i" },
        { factor_id: "learn.cook", surface: SOURCE_SURFACE,
          source_occurrence: 0, semantic_identity: F3_IDENTITY },
        { factor_id: "skill", surface: "Sichuan recipes", source_occurrence: 0,
          semantic_identity: "sichuan recipes" }
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "learned",
        predicate_factor_id: "learn.cook",
        arguments: [
          { position: 0, binding_identity: "agent", reference_kind: "factor" as const,
            reference_id: "subject" },
          { position: 1, binding_identity: "skill", reference_kind: "factor" as const,
            reference_id: "skill" }
        ]
      }]
    }
  };
}

function sourceFactFrameProposal() {
  return {
    schema_version: 1 as const,
    producer_operator_id: "source-bound-f3-fact-frame-v1",
    source_assertion: EXCERPT,
    fact_frame: {
      schema_version: 1 as const,
      slots: [
        { role: "subject" as const, text: "I" },
        { role: "relation" as const, text: SOURCE_SURFACE },
        { role: "value" as const, text: "Sichuan recipes" }
      ]
    }
  };
}
