import { describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";

const EXPECTED_EMBEDDING_FUSION_WEIGHT = 1;

function makeBasePolicy(): RecallPolicy {
  return {
    runtime_id: "runtime-parity",
    object_kind: "recall_policy",
    task_surface_ref: "task-parity",
    expires_at: null,
    derived_from: null,
    retention_policy: "session_only",
    coarse_filter: {
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: 100,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: false,
        max_supplement: 10,
        embedding_enabled: false
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: 10,
        per_dimension_limits: null
      },
      conflict_awareness: true
    }
  } as unknown as RecallPolicy;
}

function buildFixture(): {
  readonly database: StorageDatabase;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  return {
    database,
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    eventLogRepo: new SqliteEventLogRepo(database)
  };
}

describe("embedding policy parity regression net", () => {
  it("protects embedding policy parity: daemon decorator resolves embedding_similarity to 1", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of [
      "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
      "ALAYA_EMBEDDING_PROVIDER"
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "true";
    process.env.ALAYA_EMBEDDING_PROVIDER = "local_onnx";

    const fixture = buildFixture();
    try {
      const provider = {
        providerKind: "local_onnx" as const,
        modelId: "local/parity-model",
        schemaVersion: 1,
        isAvailable: true,
        embedTexts: vi.fn(async () => [new Float32Array([1])])
      };
      const { defaultPolicyDecorator, providerWarmup } = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv: new Map([
          ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"],
          ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"]
        ]),
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: {
          getRecentEvents: vi.fn(async () => Object.freeze([])),
          record: vi.fn(async () => undefined)
        },
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: vi.fn(),
        embeddingProviderOverride: provider
      });
      expect(defaultPolicyDecorator).toBeDefined();
      await expect(providerWarmup).resolves.toBe("ready");
      const decorated = defaultPolicyDecorator!(makeBasePolicy());
      expect(decorated.scoring_weight_overrides?.fusion_weights?.embedding_similarity).toBe(
        EXPECTED_EMBEDDING_FUSION_WEIGHT
      );
    } finally {
      fixture.database.close();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
