import { describe, expect, it, vi } from "vitest";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo
} from "@do-soul/alaya-storage";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";

describe("disabled embedding runtime", () => {
  it.each(["openai", "local_onnx"] as const)(
    "keeps %s unbound without warming or closing an unused override",
    async (providerKind) => {
      const database = initDatabase({ filename: ":memory:" });
      const embedTexts = vi.fn(async () => [new Float32Array([1])]);
      const close = vi.fn(async () => undefined);
      try {
        const runtime = createDaemonEmbeddingRuntime({
          database,
          configEnv: new Map([
            ["ALAYA_EMBEDDING_PROVIDER", providerKind],
            ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "false"],
            ["ALAYA_OPENAI_SECRET_REF", ""]
          ]),
          eventLogRepo: new SqliteEventLogRepo(database),
          runtimeNotifier: { notifyEntry: () => undefined },
          healthJournalService: {
            getRecentEvents: async () => [],
            record: async () => undefined
          },
          memoryEntryRepo: new SqliteMemoryEntryRepo(database),
          warn: vi.fn(),
          embeddingProviderOverride: {
            providerKind,
            modelId: "fixture-unused-model",
            schemaVersion: 1,
            isAvailable: true,
            embedTexts,
            close
          },
          localOnnxTransformersProbe: () => ({ availability: "available" })
        });

        expect(runtime.embeddingRecallService).toBeUndefined();
        expect(runtime.embeddingBackfillHandler).toBeUndefined();
        expect(runtime.defaultPolicyDecorator).toBeUndefined();
        expect(runtime.getProviderDimensions()).toBeNull();
        await expect(runtime.providerWarmup).resolves.toBe("not_requested");
        await expect(runtime.bindSourceEmbedding({ window_bytes: 4 })).resolves.toEqual({
          status: "unsupported",
          reason: "embedding_provider_unavailable"
        });
        await runtime.closeProvider();
        expect(embedTexts).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        database.close();
      }
    }
  );
});
