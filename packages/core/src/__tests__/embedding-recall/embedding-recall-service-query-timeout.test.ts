import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import { createProvider } from "./embedding-recall-test-helpers.js";
import type { EmbeddingProviderPort } from "../../embedding-recall/types.js";

describe("EmbeddingRecallService queryTimeoutMs configuration", () => {
  function buildServiceWithTimeout(options: {
    timeoutMs?: number;
    embedTexts: EmbeddingProviderPort["embedTexts"];
  }) {
    return new EmbeddingRecallService({
      runtimeNotifier: { notifyEntry: () => undefined },
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({ embedTexts: options.embedTexts }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-x",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-timeout",
      now: () => "2026-04-23T00:00:00.000Z",
      ...(options.timeoutMs === undefined ? {} : { queryTimeoutMs: options.timeoutMs })
    });
  }

  it.each([
    { label: "uses the 2500ms default when queryTimeoutMs is not configured", timeoutMs: undefined, expectedMs: 2500 },
    { label: "respects an explicit queryTimeoutMs override", timeoutMs: 800, expectedMs: 800 },
    { label: "clamps very large queryTimeoutMs to the 5000ms ceiling", timeoutMs: 60_000, expectedMs: 5000 },
    { label: "clamps very small queryTimeoutMs to the 50ms floor", timeoutMs: 1, expectedMs: 50 },
    { label: "falls back to default when queryTimeoutMs is non-finite or non-positive", timeoutMs: 0, expectedMs: 2500 }
  ])("$label", ({ timeoutMs, expectedMs }) => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: expectedMs })
    );
  });
});
