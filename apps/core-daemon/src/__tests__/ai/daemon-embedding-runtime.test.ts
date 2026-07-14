import { describe, expect, it, vi } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";

type RuntimeInput = Parameters<typeof createDaemonEmbeddingRuntime>[0];
type HealthSvc = RuntimeInput["healthJournalService"];
type WarnFn = RuntimeInput["warn"];

// invariant: this test guards the daemon's recall-policy decorator wiring.
// makeBasePolicy mirrors the production STRATEGY_RECALL_DEFAULTS shape
// (embedding_enabled:false, no injection_cap/floor) so the decorator's
// gate-opening + defaulting path is exercised, not masked. Assertions:
//   - local_onnx mode with a configured provider attaches a decorator that
//     opens semantic_supplement (enabled + embedding_enabled true) and
//     defaults injection_cap/floor while pushing
//     fusion_weights.embedding_similarity = 1
//   - an explicit injection_cap/floor on the incoming policy is preserved
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
  it(
    "attaches a decorator that injects fusion_weights.embedding_similarity = 1 when local_onnx is configured and supplement is opted in",
    async () => {
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
        expect(fusionWeights.embedding_similarity).toBe(1);
        const semantic = decorated.coarse_filter.semantic_supplement;
        expect(semantic.embedding_enabled).toBe(true);
        expect(semantic.enabled).toBe(true);
        expect(semantic.injection_cap).toBe(10);
        expect(semantic.injection_similarity_floor).toBe(0.5);
      } finally {
        teardown(fixture);
        restoreEnv();
      }
    },
    15_000
  );

  it("does not clobber an incoming policy that already specifies injection_cap / injection_similarity_floor", async () => {
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
      await expect(providerWarmup).resolves.toBe("ready");
      const base = makeBasePolicy();
      const overridden: RecallPolicy = {
        ...base,
        coarse_filter: {
          ...base.coarse_filter,
          semantic_supplement: {
            ...base.coarse_filter.semantic_supplement,
            injection_cap: 3,
            injection_similarity_floor: 0.8
          }
        }
      };
      const decorated = defaultPolicyDecorator!(overridden);
      const semantic = decorated.coarse_filter.semantic_supplement;
      expect(semantic.embedding_enabled).toBe(true);
      expect(semantic.enabled).toBe(true);
      expect(semantic.injection_cap).toBe(3);
      expect(semantic.injection_similarity_floor).toBe(0.8);
    } finally {
      teardown(fixture);
      restoreEnv();
    }
  });

  it("re-reads provider availability so an online-to-offline transition disables the decorator without restart", async () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      let available = true;
      const provider = {
        providerKind: "local_onnx",
        modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        schemaVersion: 1,
        get isAvailable() {
          return available;
        },
        embedTexts: vi.fn(async () => [new Float32Array([1])])
      };
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
        warn: fixture.warn as unknown as WarnFn,
        embeddingProviderOverride: provider
      });

      expect(defaultPolicyDecorator).toBeDefined();
      await expect(providerWarmup).resolves.toBe("ready");
      expect(
        defaultPolicyDecorator!(makeBasePolicy()).scoring_weight_overrides?.fusion_weights?.embedding_similarity
      ).toBe(1);

      available = false;
      expect(
        defaultPolicyDecorator!(makeBasePolicy()).scoring_weight_overrides?.fusion_weights?.embedding_similarity
      ).toBeUndefined();
    } finally {
      teardown(fixture);
      restoreEnv();
    }
  });

  it("defaults embedding ON for a configured local_onnx provider even without the opt-in flag", async () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      // Inject an available provider so the auto-on default-on path runs without
      // a real on-device ONNX warmup (the opt-in is computed from env: local_onnx
      // with no flag => on; the override only supplies availability).
      const provider = {
        providerKind: "local_onnx",
        modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        schemaVersion: 1,
        get isAvailable() {
          return true;
        },
        embedTexts: vi.fn(async () => [new Float32Array([1])])
      };
      const configEnv = new Map<string, string>([
        // No ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: a configured on-device local
        // ONNX provider is a first-class recall stream, on by default.
        ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"]
      ]);
      const { defaultPolicyDecorator, providerWarmup } = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv,
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: fixture.healthJournalService as unknown as HealthSvc,
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: fixture.warn as unknown as WarnFn,
        embeddingProviderOverride: provider
      });

      expect(defaultPolicyDecorator).toBeDefined();
      await expect(providerWarmup).resolves.toBe("ready");
      const decorated = defaultPolicyDecorator!(makeBasePolicy());
      expect(decorated.scoring_weight_overrides?.fusion_weights?.embedding_similarity).toBe(1);
      const semantic = decorated.coarse_filter.semantic_supplement;
      expect(semantic.enabled).toBe(true);
      expect(semantic.embedding_enabled).toBe(true);
      expect(semantic.injection_cap).toBe(10);
      expect(semantic.injection_similarity_floor).toBe(0.5);
    } finally {
      teardown(fixture);
      restoreEnv();
    }
  });

  it("defaults embedding ON for the implicit local provider", async () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      const provider = {
        providerKind: "local_onnx",
        modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        schemaVersion: 1,
        get isAvailable() {
          return true;
        },
        embedTexts: vi.fn(async () => [new Float32Array([1])])
      };
      const { defaultPolicyDecorator, providerWarmup } = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv: new Map(),
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: fixture.healthJournalService as unknown as HealthSvc,
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: fixture.warn as unknown as WarnFn,
        embeddingProviderOverride: provider
      });

      await expect(providerWarmup).resolves.toBe("ready");
      expect(defaultPolicyDecorator!(makeBasePolicy()).coarse_filter.semantic_supplement)
        .toMatchObject({ enabled: true, embedding_enabled: true });
    } finally {
      teardown(fixture);
      restoreEnv();
    }
  });

  it("keeps an API embedding provider strict opt-in (decorator absent without the flag)", () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      const configEnv = new Map<string, string>([
        // openai provider, no opt-in flag, no key -> stays off (cost/network).
        ["ALAYA_EMBEDDING_PROVIDER", "openai"]
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

  it("leaves the decorator undefined and policies untouched when ALAYA_ENABLE_EMBEDDING_SUPPLEMENT is off", () => {
    saveEnv();
    const fixture = buildFixture();
    try {
      const configEnv = new Map<string, string>([
        // Explicit false is the stable opt-out; omission keeps the local default on.
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

  it("keeps local answer reranking opt-in and model-configurable", () => {
    const fixture = buildFixture();
    try {
      const disabled = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv: new Map(),
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: fixture.healthJournalService as unknown as HealthSvc,
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: fixture.warn as unknown as WarnFn
      });
      const enabled = createDaemonEmbeddingRuntime({
        database: fixture.database,
        configEnv: new Map([
          ["ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK", "true"],
          ["ALAYA_LOCAL_CROSS_ENCODER_MODEL", "local/test-reranker"]
        ]),
        eventLogRepo: fixture.eventLogRepo,
        healthJournalService: fixture.healthJournalService as unknown as HealthSvc,
        memoryEntryRepo: fixture.memoryEntryRepo,
        warn: fixture.warn as unknown as WarnFn
      });

      expect(disabled.answerRerankService).toBeUndefined();
      expect(enabled.answerRerankService?.modelId).toBe("local/test-reranker");
    } finally {
      teardown(fixture);
    }
  });

});
