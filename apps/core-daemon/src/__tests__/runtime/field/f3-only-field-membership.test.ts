import { describe, expect, it, vi } from "vitest";
import { EvidenceService, fieldContractSha256, RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER } from "@do-soul/alaya-core";
import { formatVerifiedUserAssertionSourceHash } from "@do-soul/alaya-protocol";
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

  it.each(["explicit", "automatic"])("retains conditional evidence without OSF or F3 from the %s frame path", async (path) => {
    const database = planted.openMemoryDatabase();
    const field = composeField(database);
    const source = `${EXCERPT}, but only if I had all the ingredients.`;
    await createF3Evidence(database, field, source, path === "automatic");
    expect(await new SqliteEvidenceCapsuleRepo(database).findById(EVIDENCE_ID)).toMatchObject({ excerpt: source });
    expect(database.connection.prepare("SELECT status, fact_frame_json FROM evidence_fact_frame_formations WHERE evidence_object_id = ?")
      .get(EVIDENCE_ID)).toEqual({ status: path === "automatic" ? "unavailable" : "rejected", fact_frame_json: null });
    const semantic = database.connection.prepare(
      "SELECT status, graph_json, semantic_completeness_json FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?"
    ).get(EVIDENCE_ID) as { status: string; graph_json: string | null; semantic_completeness_json: string };
    expect(semantic).toMatchObject({ status: "unavailable", graph_json: null });
    expect(JSON.parse(semantic.semantic_completeness_json)).toMatchObject({ status: "not_applicable", reason_code: "upstream_not_formed" });
    expect(field.fieldRepos.factors.listDescriptors(WORKSPACE_ID).filter((row) => row.family === "f3")).toEqual([]);
    expect(field.fieldRepos.factors.listIncidences(WORKSPACE_ID).length).toBeGreaterThan(0);
  });
});

async function createF3Evidence(
  database: Parameters<typeof composeField>[0],
  field: ReturnType<typeof composeField>,
  source = EXCERPT,
  automatic = false
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
    },
    factFrameProposalNormalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
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
    excerpt: source,
    source_hash: formatVerifiedUserAssertionSourceHash("b".repeat(64)),
    run_id: "run-1",
    workspace_id: WORKSPACE_ID,
    surface_id: null
  }, [], automatic ? undefined : sourceFactFrameProposal(source), sourceSemanticProposal(source));
  expect(extract).not.toHaveBeenCalled();
}

function sourceSemanticProposal(source: string) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "open-factor-test-producer-v1",
    source_text: source,
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

function sourceFactFrameProposal(source: string) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "source-bound-f3-fact-frame-v1",
    source_assertion: source,
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
