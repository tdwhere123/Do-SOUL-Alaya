import { describe, expect, it, vi } from "vitest";
import {
  EvidenceService,
  RuleBasedQueryFactFrameExtractor,
  captureRecallQueryFactFrames,
  deriveQueryFactFrameOsfObligation,
  materializeOpenSemanticFactorFormation,
  fieldContractSha256
} from "@do-soul/alaya-core";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  certifyQueryOsfSemanticCompleteness,
  queryOsfSemanticCompletenessReceiptPreimage,
  type QueryOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
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
const EXCERPT = "I completed Sichuan recipes last autumn";
const QUERY = "What skill did I master?";
const F3_IDENTITY = "learn cook";
const SOURCE_SURFACE = "completed";
const QUERY_SURFACE = "master";

describe("F3-only field membership", () => {
  it("admits a source-bound F3 identity into field membership", async () => {
    const runtime = await openF3Recall();
    assertPlantDoesNotLeakIdentity(EXCERPT, runtime.memory.content);
    const lexicalQuery = await runtime.memoryRepo.searchByKeyword(WORKSPACE_ID, QUERY, 10);
    const lexicalIdentity = await runtime.memoryRepo.searchByKeyword(
      WORKSPACE_ID, F3_IDENTITY, 10
    );
    const certified = await formedQueryCapture(QUERY);
    const result = await runtime.recall.recall({
      ...recallRequest(QUERY),
      querySemanticFactorFormationCapture: certified.capture,
      querySemanticFactorCompletenessReceipt: certified.receipt
    });
    const control = await runtime.recall.recall(recallRequest(QUERY));
    const foreign = await runtime.recall.recall({
      ...recallRequest(QUERY),
      querySemanticFactorFormationCapture: certified.capture,
      querySemanticFactorCompletenessReceipt: foreignReceipt(certified.receipt)
    });
    const winner = result.candidates.find((candidate) => candidate.object_id === MEMORY_ID);
    const diagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === MEMORY_ID
    );
    const fieldTrace = result.diagnostics?.field_projection_trace;

    expect(lexicalQuery.map((hit) => hit.object_id)).not.toContain(MEMORY_ID);
    expect(lexicalIdentity.map((hit) => hit.object_id)).not.toContain(MEMORY_ID);
    expect(control.candidates.map((candidate) => candidate.object_id)).not.toContain(MEMORY_ID);
    expect(foreign.candidates.map((candidate) => candidate.object_id)).not.toContain(MEMORY_ID);
    expect(result.diagnostics?.query_open_semantic_factor_formation?.status).toBe("formed");
    expect(result.diagnostics?.query_probes.expanded_terms).toContain(F3_IDENTITY);
    expect(result.diagnostics?.query_condition?.query_cache_key)
      .not.toBe(control.diagnostics?.query_condition?.query_cache_key);
    expect(fieldTrace?.candidate_keys).toEqual([EVIDENCE_ID]);
    expect(fieldTrace?.generation_id).toEqual(expect.any(String));
    expect(fieldTrace?.condition_digest).toEqual(expect.any(String));
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([MEMORY_ID]);
    expect(winner?.source_channels).toContain("field_projection");
    expect(diagnostic?.admission_planes).toEqual(["activation"]);
    expect(diagnostic?.plane_winning_admission).toBe("activation");
  });

  it("admits F3 membership from live query certification at prepare", async () => {
    const extractCertifiedQuery = vi.fn(async (
      sourceText: string,
      obligation: Parameters<typeof certifyQueryOsfSemanticCompleteness>[0]["obligation"]
    ) => {
      const graph = queryGraph(sourceText);
      const receipt = certifyQueryOsfSemanticCompleteness({
        query_text: sourceText, graph, obligation,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        sha256: fieldContractSha256
      });
      return receipt === null ? null : {
        schema_version: 1 as const,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        graph,
        semantic_completeness_receipt: receipt
      };
    });
    const runtime = await openF3Recall({
      openSemanticFactorExtractionPort: {
        operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        extract: async () => null,
        extractCertifiedQuery
      }
    });
    const result = await runtime.recall.recall(recallRequest(QUERY));
    expect(extractCertifiedQuery).toHaveBeenCalledOnce();
    expect(result.diagnostics?.query_open_semantic_factor_formation?.status).toBe("formed");
    expect(result.diagnostics?.query_probes.expanded_terms).toContain(F3_IDENTITY);
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([MEMORY_ID]);
  });
});

async function openF3Recall(
  extra?: Parameters<typeof createPlantedRecall>[0]["extra"]
) {
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
    recall: createPlantedRecall({ database, field, memoryRepo, extra: {
      queryFactFrameExtractionPort: new RuleBasedQueryFactFrameExtractor(),
      ...extra
    } })
  };
}

function foreignReceipt(receipt: QueryOsfSemanticCompletenessReceipt) {
  const { receipt_digest: _digest, ...current } = receipt;
  const body = { ...current,
    query_digest: `sha256:${fieldContractSha256("foreign query")}` as const };
  return { ...body,
    receipt_digest: `sha256:${fieldContractSha256(
      queryOsfSemanticCompletenessReceiptPreimage(body)
    )}` as const };
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
      schema_version: 2 as const,
      source_kind: "evidence" as const,
      factors: [{
        factor_id: "learn.cook",
        surface: SOURCE_SURFACE,
        source_occurrence: 0, semantic_identity: F3_IDENTITY
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

async function formedQueryCapture(queryText: string) {
  const factFrameCapture = await captureRecallQueryFactFrames({
    query_text: queryText, port: new RuleBasedQueryFactFrameExtractor()
  });
  const obligation = deriveQueryFactFrameOsfObligation({
    query_text: queryText, fact_frame_capture: factFrameCapture
  });
  if (obligation === null) throw new Error("expected planted query obligation");
  const graph = queryGraph(queryText);
  const receipt = certifyQueryOsfSemanticCompleteness({
    query_text: queryText, graph, obligation,
    producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
    sha256: fieldContractSha256
  });
  if (receipt === null) throw new Error("expected planted completeness receipt");
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: queryText,
    proposal: {
      schema_version: 1 as const,
      producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
      source_text: queryText,
      graph
    }
  });
  return { capture, receipt };
}

function queryGraph(queryText: string) {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [{ factor_id: "learn.cook", surface: QUERY_SURFACE,
      source_occurrence: 0, semantic_identity: F3_IDENTITY },
    { factor_id: "subject", surface: "I", source_occurrence: 0, semantic_identity: "i" }],
    variables: [{ variable_id: "answer", surface: queryText.slice(0, 10) , source_occurrence: 0}],
    result_variable_ids: ["answer"],
    propositions: [{ proposition_id: "query", predicate_factor_id: "learn.cook",
      arguments: [{ position: 0, binding_identity: "agent",
        reference_kind: "factor" as const, reference_id: "subject" },
      { position: 1, binding_identity: "object",
        reference_kind: "variable" as const, reference_id: "answer" }] }]
  };
}

function assertPlantDoesNotLeakIdentity(excerpt: string, content: string): void {
  const haystack = `${excerpt}\n${content}`.toLowerCase();
  expect(haystack).not.toContain("learn");
  expect(haystack).not.toContain("cook");
}
