import { describe, expect, it, vi } from "vitest";
import {
  EvidenceService,
  materializeOpenSemanticFactorFormation,
  fieldContractSha256
} from "@do-soul/alaya-core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo
} from "@do-soul/alaya-storage";
import {
  CLOCK,
  EVIDENCE_ID,
  MEMORY_ID,
  WORKSPACE_ID,
  composeField,
  createPlantedHarness,
  createPlantedRecall,
  memoryEntry,
  persistMemory,
  realMemoryRepo,
  recallRequest
} from "./p217-planted-harness.js";

const planted = createPlantedHarness();
const EXCERPT = "Picked up Sichuan recipes last autumn";
const QUERY = "Which cuisine was mastered?";
const F3_IDENTITY = "learn cook";
const SOURCE_SURFACE = "Picked up";
const QUERY_SURFACE = "mastered";

describe("F3-only field membership", () => {
  it("admits a source-bound F3 identity into field membership", async () => {
    const runtime = await openF3Recall();
    assertPlantDoesNotLeakIdentity(EXCERPT, runtime.memory.content);
    const lexicalQuery = await runtime.memoryRepo.searchByKeyword(WORKSPACE_ID, QUERY, 10);
    const lexicalIdentity = await runtime.memoryRepo.searchByKeyword(
      WORKSPACE_ID, F3_IDENTITY, 10
    );
    const result = await runtime.recall.recall({
      ...recallRequest(QUERY),
      querySemanticFactorFormationCapture: formedQueryCapture(QUERY)
    });
    const control = await runtime.recall.recall(recallRequest(QUERY));
    const winner = result.candidates.find((candidate) => candidate.object_id === MEMORY_ID);
    const diagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === MEMORY_ID
    );
    const fieldTrace = result.diagnostics?.field_projection_trace;

    expect(lexicalQuery.map((hit) => hit.object_id)).not.toContain(MEMORY_ID);
    expect(lexicalIdentity.map((hit) => hit.object_id)).not.toContain(MEMORY_ID);
    expect(control.candidates.map((candidate) => candidate.object_id)).not.toContain(MEMORY_ID);
    expect(result.diagnostics?.query_open_semantic_factor_formation?.status).toBe("formed");
    expect(fieldTrace?.candidate_keys).toEqual([EVIDENCE_ID]);
    expect(fieldTrace?.generation_id).toEqual(expect.any(String));
    expect(fieldTrace?.condition_digest).toEqual(expect.any(String));
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([MEMORY_ID]);
    expect(winner?.source_channels).toContain("field_projection");
    expect(diagnostic?.admission_planes).toEqual(["activation"]);
    expect(diagnostic?.plane_winning_admission).toBe("activation");
  });
});

async function openF3Recall() {
  const database = planted.openMemoryDatabase();
  const field = composeField(database);
  await createF3Evidence(database, field);
  const memory = await persistMemory(database, memoryEntry({
    content: "Sealed procedural binder."
  }));
  const memoryRepo = realMemoryRepo(database);
  return {
    memory,
    memoryRepo,
    recall: createPlantedRecall({ database, field, memoryRepo })
  };
}

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
    source_hash: null,
    run_id: "run-1",
    workspace_id: WORKSPACE_ID,
    surface_id: null
  }, [], undefined, sourceSemanticProposal());
  expect(extract).not.toHaveBeenCalled();
}

function sourceSemanticProposal() {
  return {
    schema_version: 1 as const,
    producer_operator_id: "open-factor-test-producer-v1",
    source_text: EXCERPT,
    graph: {
      schema_version: 1 as const,
      source_kind: "evidence" as const,
      factors: [{
        factor_id: "learn.cook",
        surface: SOURCE_SURFACE,
        semantic_identity: F3_IDENTITY
      }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "learned",
        predicate_factor_id: "learn.cook",
        arguments: [{
          position: 0,
          binding_identity: "skill",
          reference_kind: "factor" as const,
          reference_id: "learn.cook"
        }]
      }]
    }
  };
}

function formedQueryCapture(queryText: string) {
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: queryText,
    proposal: {
      schema_version: 1 as const,
      producer_operator_id: "open-factor-test-producer-v1",
      source_text: queryText,
      graph: {
        schema_version: 1 as const,
        source_kind: "query" as const,
        factors: [{
          factor_id: "learn.cook",
          surface: QUERY_SURFACE,
          semantic_identity: F3_IDENTITY
        }],
        variables: [{
          variable_id: "answer",
          surface: queryText.slice(0, 3).trim() || "how"
        }],
        result_variable_ids: ["answer"],
        propositions: [{
          proposition_id: "query",
          predicate_factor_id: "learn.cook",
          arguments: [{
            position: 0,
            binding_identity: "agent",
            reference_kind: "variable" as const,
            reference_id: "answer"
          }]
        }]
      }
    }
  });
}

function assertPlantDoesNotLeakIdentity(excerpt: string, content: string): void {
  const haystack = `${excerpt}\n${content}`.toLowerCase();
  expect(haystack).not.toContain("learn");
  expect(haystack).not.toContain("cook");
  expect(haystack).not.toContain(QUERY_SURFACE);
  expect(haystack).not.toContain("cuisine");
}
