import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import { createProvider } from "./embedding-recall-test-helpers.js";

describe("coherent pair availability", () => {
  it("distinguishes a failed vector read from a valid empty vector set", async () => {
    const read = vi.fn(async () => []);
    const failure = new Error("vector read unavailable");
    read.mockRejectedValueOnce(failure);
    const service = new EmbeddingRecallService({ embeddingRepo: { listByObjectIds: read },
      provider: createProvider(), runtimeNotifier: { notifyEntry: () => undefined },
      eventLogRepo: { queryByEntity: async () => [], append: async (input): Promise<EventLogEntry> => ({
        ...input, event_id: "event", revision: 0, created_at: "2026-04-23T00:00:00.000Z"
      }) }, warn: () => undefined
    });
    const input = { workspaceId: "workspace-1", runId: null, objectIds: ["a", "b"], floor: 0.5 };
    await expect(service.coherentPairKeys(input)).rejects.toBe(failure);
    await expect(service.coherentPairKeys(input)).resolves.toEqual(new Set());
  });
});
