import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import { createProvider } from "./embedding-recall-test-helpers.js";
import type { TestMock } from "../shared/mock-types.js";

describe("EmbeddingRecallService queryTimeoutMs configuration", () => {
  function buildServiceWithTimeout(options: { timeoutMs?: number; embedTexts: TestMock }) {
    return new EmbeddingRecallService({
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

  it("uses the 2500ms default when queryTimeoutMs is not configured", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 2500 })
    );
  });

  it("respects an explicit queryTimeoutMs override", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 800, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 800 })
    );
  });

  it("clamps very large queryTimeoutMs to the 5000ms ceiling", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 60_000, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 5000 })
    );
  });

  it("clamps very small queryTimeoutMs to the 50ms floor", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 1, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 50 })
    );
  });

  it("falls back to default when queryTimeoutMs is non-finite or non-positive", () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = buildServiceWithTimeout({ timeoutMs: 0, embedTexts });
    service.prepareQueryEmbedding({ workspaceId: "ws-1", runId: null, queryText: "hello" });
    expect(embedTexts).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ timeoutMs: 2500 })
    );
  });
});
