import { describe, expect, it } from "vitest";

import {
  deriveProjectedRoutingKeysV2
} from "../../recall/flood/projected-routing-keys.js";

describe("projected routing keys", () => {
  it("keeps proposal authority and source independence on every derived key", () => {
    const keys = deriveProjectedRoutingKeysV2({
      workspaceId: "workspace-1",
      asOfMs: 1_773_811_200_000,
      projection: {
        owner_id: "memory-1",
        owner_kind: "memory_entry",
        source_signal_id: "signal-1",
        independence_group: "source-event:source-event-1",
        signal_kind: "potential_preference",
        object_type: "preference",
        reliability: 0.82,
        proposed_entities: ["Bandung", "Cihampelas Walk"],
        proposed_preference: {
          subject: "user",
          predicate: "likes",
          object: "nasi goreng",
          category: "food",
          polarity: "positive"
        },
        temporal: {
          start: "2026-03-18T00:00:00.000Z",
          end: "2026-03-18T01:00:00.000Z",
          precision: "hour"
        },
        proposed_fact: "The user liked the nasi goreng at Cihampelas Walk.",
        source_version: "signal:signal-1:2026-03-18T02:00:00.000Z"
      }
    });

    expect(keys.map((key) => [key.dimension, key.normalized_value])).toEqual([
      ["entity", "bandung"],
      ["entity", "cihampelas walk"],
      ["preference_category", "food"],
      ["preference_object", "nasi goreng"],
      ["preference_polarity", "positive"],
      ["preference_predicate", "likes"],
      ["preference_subject", "user"],
      ["semantic", "the user liked the nasi goreng at cihampelas walk."],
      ["time", "day:2026-03-18"],
      ["time", "month:2026-03"]
    ]);
    expect(keys.every((key) => key.owner_id === "memory-1")).toBe(true);
    expect(keys.every((key) => key.authority === "proposed_routing_only")).toBe(true);
    expect(keys.every((key) => key.reliability === 0.82)).toBe(true);
    expect(keys.every((key) =>
      key.independence_group === "source-event:source-event-1"
    )).toBe(true);
  });
});
