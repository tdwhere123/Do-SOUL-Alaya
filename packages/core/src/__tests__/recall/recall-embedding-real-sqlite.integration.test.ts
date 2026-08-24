import { afterEach, describe, expect, it } from "vitest";
import {
  ComputeRecallGardenEventType,
  ControlPlaneObjectKind,
  RetentionPolicy,
  type EventLogEntry,
  type RecallPolicy,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { NO_STORED_VECTORS_DEGRADATION_REASON } from "../../embedding-recall/constants.js";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEmbeddingRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import {
  RecallService,
  type RecallServiceDependencies,
  type RecallServiceFieldDeps
} from "../../recall/recall-service.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../recall/runtime/query/field-query-session.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { hashMemoryContent } from "../embedding-recall/embedding-recall-test-helpers.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallEmbeddingRealStorage
} from "../shared/real-sqlite.test-support.js";
import { createMemoryEntry, overridePolicy } from "./recall-service-test-fixtures.js";

const WS = REAL_SQLITE_TEST_WORKSPACE_ID;
const RUN = REAL_SQLITE_TEST_RUN_ID;
const NOW = "2026-07-29T00:00:00.000Z";

const PROVIDER_KIND = "openai";
const MODEL_ID = "text-embedding-3-small";
const SCHEMA_VERSION = 1;

const LEXICAL_ID = "00000000-0000-4000-8000-000000000001";
const SEMANTIC_ID = "00000000-0000-4000-8000-000000000002";

const LEXICAL_CONTENT =
  "kubernetes staging pipeline deployment checklist alpha procedure.";
const SEMANTIC_CONTENT = "Zephyr qixotl mnop hidden semantic vector only.";

const QUERY_TEXT = "kubernetes staging pipeline deployment checklist";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

type RecallEmbeddingFixture = Readonly<{
  readonly database: StorageDatabase;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
  readonly memoryEmbeddingRepo: SqliteMemoryEmbeddingRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly recallService: RecallService;
}>;

// anti-patterns-lint-allow: real-DB stand-up mirrors recall integration precedents on purpose.
async function createRecallEmbeddingFixture(params: {
  readonly seedVectors: boolean;
}): Promise<RecallEmbeddingFixture> {
  const storage = await createRecallEmbeddingRealStorage((database) => {
    databases.add(database);
  });

  await storage.memoryEntryRepo.create(
    createMemoryEntry({
      object_id: LEXICAL_ID,
      content: LEXICAL_CONTENT,
      activation_score: 0.8
    })
  );
  await storage.memoryEntryRepo.create(
    createMemoryEntry({
      object_id: SEMANTIC_ID,
      content: SEMANTIC_CONTENT,
      activation_score: 0.1
    })
  );

  if (params.seedVectors) {
    await storage.memoryEmbeddingRepo.upsert({
      object_id: LEXICAL_ID,
      workspace_id: WS,
      content_hash: hashMemoryContent(LEXICAL_CONTENT),
      provider_kind: PROVIDER_KIND,
      model_id: MODEL_ID,
      schema_version: SCHEMA_VERSION,
      dimensions: 2,
      embedding: new Float32Array([0.01, 0.99]),
      created_at: NOW,
      updated_at: NOW
    });
    await storage.memoryEmbeddingRepo.upsert({
      object_id: SEMANTIC_ID,
      workspace_id: WS,
      content_hash: hashMemoryContent(SEMANTIC_CONTENT),
      provider_kind: PROVIDER_KIND,
      model_id: MODEL_ID,
      schema_version: SCHEMA_VERSION,
      dimensions: 2,
      embedding: new Float32Array([0.99, 0.01]),
      created_at: NOW,
      updated_at: NOW
    });
  }

  return {
    ...storage,
    recallService: buildRecallService(storage)
  };
}

function buildRecallService(params: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
  readonly memoryEmbeddingRepo: SqliteMemoryEmbeddingRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
}): RecallService {
  const memoryRepo = params.memoryEntryRepo;
  const embeddingRecallService = new EmbeddingRecallService({
    embeddingRepo: params.memoryEmbeddingRepo,
    provider: createDeterministicEmbeddingProvider(),
    eventLogRepo: params.eventLogRepo,
    generateQueryId: () => "recall-embedding-real-sqlite-query",
    now: () => NOW
  });

  const deps: RecallServiceDependencies & RecallServiceFieldDeps = {
    testOnlyAllowInMemoryFieldQuerySession: true,
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256,
      REAL_SQLITE_TEST_WORKSPACE_ID
    ),
    now: () => NOW,
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: memoryRepo.findByWorkspaceId.bind(memoryRepo),
      findByDimension: memoryRepo.findByDimension.bind(memoryRepo),
      findByScopeClass: memoryRepo.findByScopeClass.bind(memoryRepo),
      searchByKeyword: memoryRepo.searchByKeyword.bind(memoryRepo),
      searchByKeywordWithinObjectIds: memoryRepo.searchByKeywordWithinObjectIds.bind(memoryRepo),
      findByEvidenceRefs: memoryRepo.findByEvidenceRefs.bind(memoryRepo)
    },
    slotRepo: {
      findByWorkspace: async () => []
    },
    eventLogRepo: params.eventLogRepo,
    evidenceSearchPort: {
      searchByKeyword: params.evidenceCapsuleRepo.searchByKeyword.bind(params.evidenceCapsuleRepo),
      findByIds: (workspaceId: string, evidenceObjectIds: readonly string[]) =>
        params.evidenceCapsuleRepo.findByIds(workspaceId, evidenceObjectIds)
    },
    embeddingRecallService
  };

  return new RecallService(deps);
}

function createDeterministicEmbeddingProvider() {
  return {
    providerKind: PROVIDER_KIND,
    modelId: MODEL_ID,
    schemaVersion: SCHEMA_VERSION,
    isAvailable: true,
    embedTexts: async (texts: readonly string[]) =>
      texts.map((text) => deterministicEmbeddingForText(text))
  };
}

function deterministicEmbeddingForText(text: string): Float32Array {
  if (text === QUERY_TEXT) {
    return new Float32Array([0.95, 0.05]);
  }
  if (text.includes("Zephyr qixotl")) {
    return new Float32Array([1, 0]);
  }
  if (text.includes("deployment checklist")) {
    return new Float32Array([0, 1]);
  }
  return new Float32Array([0.5, 0.5]);
}

function createTaskSurface(displayName: string): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-13T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "analyze",
    display_name: displayName,
    context_refs: []
  };
}

function embeddingEnabledPolicy(recallService: RecallService): RecallPolicy {
  const base = recallService.buildDefaultPolicy("analyze", createTaskSurface(QUERY_TEXT).runtime_id);
  return overridePolicy(base, {
    coarse_filter: {
      ...base.coarse_filter,
      semantic_supplement: {
        enabled: true,
        max_supplement: 5,
        embedding_enabled: true
      }
    },
    fine_assessment: {
      ...base.fine_assessment,
      budgets: {
        ...base.fine_assessment.budgets,
        max_entries: 2
      }
    }
  });
}
describe("RecallService embedding integration (real SQLite + stored vectors)", () => {
  it("changes delivered ranking when stored vectors are present versus an empty vector table", async () => {
    const withVectors = await createRecallEmbeddingFixture({ seedVectors: true });
    const withoutVectors = await createRecallEmbeddingFixture({ seedVectors: false });
    const policy = embeddingEnabledPolicy(withVectors.recallService);

    const live = await withVectors.recallService.recall({
      taskSurface: createTaskSurface(QUERY_TEXT),
      workspaceId: WS,
      runId: RUN,
      strategy: "analyze",
      policyOverride: policy,
      diagnosticCapture: "answer_features"
    });
    const emptyTable = await withoutVectors.recallService.recall({
      taskSurface: createTaskSurface(QUERY_TEXT),
      workspaceId: WS,
      runId: RUN,
      strategy: "analyze",
      policyOverride: embeddingEnabledPolicy(withoutVectors.recallService),
      diagnosticCapture: "answer_features"
    });

    expect(live.candidates.slice(0, 2).map((candidate) => candidate.object_id)).toEqual([
      SEMANTIC_ID,
      LEXICAL_ID
    ]);
    expect(live.diagnostics?.provider_degradation_reason).toBeNull();

    // Empty vector table still fills the delivery budget from non-embedding
    // paths; the regression signal is ranking flip plus no_stored_vectors.
    expect(emptyTable.candidates.slice(0, 2).map((candidate) => candidate.object_id)).toEqual([
      LEXICAL_ID,
      SEMANTIC_ID
    ]);
    expect(emptyTable.diagnostics?.provider_degradation_reason).toBe(
      NO_STORED_VECTORS_DEGRADATION_REASON
    );

    withVectors.database.close();
    withoutVectors.database.close();
    databases.delete(withVectors.database);
    databases.delete(withoutVectors.database);
  });

  it("surfaces no_stored_vectors through recall diagnostics and SqliteEventLogRepo", async () => {
    const fixture = await createRecallEmbeddingFixture({ seedVectors: false });

    const result = await fixture.recallService.recall({
      taskSurface: createTaskSurface(QUERY_TEXT),
      workspaceId: WS,
      runId: RUN,
      strategy: "analyze",
      policyOverride: embeddingEnabledPolicy(fixture.recallService),
      diagnosticCapture: "answer_features"
    });

    expect(result.diagnostics?.provider_degradation_reason).toBe(
      NO_STORED_VECTORS_DEGRADATION_REASON
    );
    expect(result.diagnostics?.embedding_provider_status).toBe("provider_failed");

    const events = await fixture.eventLogRepo.queryByWorkspaceAll(WS);
    const degradedEvents = events.filter(
      (entry: EventLogEntry) =>
        entry.event_type === ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED
    );
    expect(degradedEvents.length).toBeGreaterThan(0);
    expect(degradedEvents.some((entry) => {
      const payload = entry.payload_json as { readonly degradation_reason?: string };
      return payload.degradation_reason === NO_STORED_VECTORS_DEGRADATION_REASON;
    })).toBe(true);

    fixture.database.close();
    databases.delete(fixture.database);
  });
});
