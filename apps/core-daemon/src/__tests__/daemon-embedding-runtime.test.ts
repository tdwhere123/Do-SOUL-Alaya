import { describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonEmbeddingRuntime } from "../daemon-embedding-runtime.js";

type RuntimeInput = Parameters<typeof createDaemonEmbeddingRuntime>[0];
type HealthSvc = RuntimeInput["healthJournalService"];
type WarnFn = RuntimeInput["warn"];

// invariant: this test guards the daemon's recall-policy decorator wiring
// (Blocking 1 fix in v0.3.11 Phase 3 WS-D). Three assertions:
//   - local_onnx mode with a configured provider attaches a decorator
//   - the decorator pushes fusion_weights.embedding_similarity = 6 (or the
//     ALAYA_EMBEDDING_FUSION_WEIGHT_ON override)
//   - embedding-off mode leaves the decorator absent and policies untouched
// The decorator reads provider.isAvailable lazily so the test exercises the
// happy "configured" path and the dynamic-degradation pass-through.

function makeBasePolicy(): RecallPolicy {
  return {
    runtime_id: "runtime-stub",
    object_kind: "recall_policy",
    task_surface_ref: "task-stub",
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
        enabled: true,
        max_supplement: 10,
        embedding_enabled: true
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

interface RuntimeFixture {
  readonly database: StorageDatabase;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly healthJournalService: {
    readonly getRecentEvents: ReturnType<typeof vi.fn>;
    readonly record: ReturnType<typeof vi.fn>;
  };
  readonly warn: ReturnType<typeof vi.fn>;
}

function buildFixture(): RuntimeFixture {
  const database = initDatabase({ filename: ":memory:" });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const healthJournalService = {
    getRecentEvents: vi.fn(async () => Object.freeze([])),
    record: vi.fn(async () => undefined)
  };
  const warn = vi.fn();
  return { database, memoryEntryRepo, eventLogRepo, healthJournalService, warn };
}

function teardown(fixture: RuntimeFixture): void {
  fixture.database.close();
}

const SAVED_ENV: Record<string, string | undefined> = {};
const MANAGED_KEYS = [
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_EMBEDDING_PROVIDER",
  "ALAYA_LOCAL_EMBEDDING_CACHE_DIR",
  "ALAYA_LOCAL_EMBEDDING_MODEL",
  "ALAYA_EMBEDDING_FUSION_WEIGHT_ON",
  "ALAYA_OPENAI_SECRET_REF",
  "OPENAI_API_KEY"
] as const;

function saveEnv(): void {
  for (const key of MANAGED_KEYS) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of MANAGED_KEYS) {
    if (SAVED_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = SAVED_ENV[key];
    }
  }
}

describe("createDaemonEmbeddingRuntime — recall policy decorator wiring", () => {
  it("attaches a decorator that injects fusion_weights.embedding_similarity = 6 when local_onnx is configured and supplement is opted in", async () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      const configEnv = new Map<string, string>([
        ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"],
        ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"]
      ]);
      const { defaultPolicyDecorator, providerWarmup } = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv,
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: fixture.healthJournalService as unknown as HealthSvc,
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: fixture.warn as unknown as WarnFn
      });

      expect(defaultPolicyDecorator).toBeDefined();
      // Warmup must be a no-throw promise so daemon boot is never blocked.
      await expect(providerWarmup).resolves.toBeDefined();

      const decorated = defaultPolicyDecorator!(makeBasePolicy());
      const fusionWeights =
        decorated.scoring_weight_overrides?.fusion_weights ?? {};
      expect(fusionWeights.embedding_similarity).toBe(6);
    } finally {
      teardown(fixture);
      restoreEnv();
    }
  });

  it("respects ALAYA_EMBEDDING_FUSION_WEIGHT_ON env override on the injected fusion weight", async () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      const configEnv = new Map<string, string>([
        ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"],
        ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"],
        ["ALAYA_EMBEDDING_FUSION_WEIGHT_ON", "9.5"]
      ]);
      const { defaultPolicyDecorator } = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv,
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: fixture.healthJournalService as unknown as HealthSvc,
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: fixture.warn as unknown as WarnFn
      });

      expect(defaultPolicyDecorator).toBeDefined();
      const decorated = defaultPolicyDecorator!(makeBasePolicy());
      expect(decorated.scoring_weight_overrides?.fusion_weights?.embedding_similarity).toBe(9.5);
    } finally {
      teardown(fixture);
      restoreEnv();
    }
  });

  it("leaves the decorator undefined and policies untouched when ALAYA_ENABLE_EMBEDDING_SUPPLEMENT is off", () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      const configEnv = new Map<string, string>([
        // The opt-in flag must be the literal string "true" to enable embedding;
        // omit / "false" means embedding-off — the red-line path that must stay
        // bit-identical to the no-embedding baseline.
        ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "false"],
        ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"]
      ]);
      const { defaultPolicyDecorator } = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv,
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: fixture.healthJournalService as unknown as HealthSvc,
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: fixture.warn as unknown as WarnFn
      });

      expect(defaultPolicyDecorator).toBeUndefined();
    } finally {
      teardown(fixture);
      restoreEnv();
    }
  });

});
