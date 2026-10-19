import { afterEach, describe, expect, it } from "vitest";
import {
  BOUNDED_JSON_OBJECT_MAX_CHARS,
  EVENT_LOG_PAYLOAD_MAX_CHARS,
  ManifestationDecisionSchema,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload
} from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { appendManifestationGovernanceEvents } from "../../manifestation/manifestation-event-writer.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { createRecallRealStorage } from "../shared/real-sqlite.test-support.js";
import { NOW } from "./manifestation-resolver.test-support.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("manifestation EventLog serialization", () => {
  it("persists maximum escaped reasons in lossless batches under the EventLog budget", async () => {
    const { database } = await createRecallRealStorage((db) => databases.add(db));
    const eventLogRepo = new SqliteEventLogRepo(database);
    const publisher = new EventPublisher({
      eventLogRepo,
      runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined },
      runHotStateService: { apply: () => undefined }
    });
    const decisions = Array.from({ length: 100 }, (_, index) => ManifestationDecisionSchema.parse({
      candidate_id: `candidate-${index}`,
      source_path_id: "path-1",
      assigned_level: null,
      reason: "\u0000".repeat(16_384),
      budget_remaining: { stance_bias: 0, dialogue_nudge: 0, lens_entry: 0 }
    }));

    await appendManifestationGovernanceEvents({
      eventLogWriter: {
        appendAtomically: (entries) => publisher.appendManyWithMutation(entries, (committed) => committed)
      },
      workspaceId: "workspace-1",
      runId: "run-1",
      decisions,
      decidedAt: NOW
    });

    const events = await eventLogRepo.queryByRunAll("run-1");
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      event_type: RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
      payload_json: { total_candidates: 100, discarded: 100 }
    });
    const batches = events.slice(1).map((event) => {
      expect(event.event_type).toBe(RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED);
      const serialized = JSON.stringify(event.payload_json);
      expect(serialized.length).toBeGreaterThan(BOUNDED_JSON_OBJECT_MAX_CHARS);
      expect(serialized.length).toBeLessThanOrEqual(EVENT_LOG_PAYLOAD_MAX_CHARS);
      return parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED, event.payload_json
      );
    });
    expect(batches.map(({ batch_index, batch_count }) => ({ batch_index, batch_count })))
      .toEqual([{ batch_index: 0, batch_count: 2 }, { batch_index: 1, batch_count: 2 }]);
    expect(batches.every(({ decisions: items }) => items.length > 0)).toBe(true);
    expect(batches.flatMap(({ decisions: items }) => items))
      .toEqual(decisions.map(({ candidate_id, assigned_level, reason }) => ({ candidate_id, assigned_level, reason })));
  });
});
