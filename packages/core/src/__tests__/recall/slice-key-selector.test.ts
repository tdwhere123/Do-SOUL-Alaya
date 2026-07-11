import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";

import {
  createSelectedSliceKeyV1,
  type SelectedSliceKeyV1
} from "../../recall/flood/slice-key-contract.js";
import {
  deriveMemorySliceKeysV1,
  derivePathAnchorSliceKeysV1,
  deriveQuerySliceKeysV1,
  selectSliceCompatibilityV1
} from "../../recall/flood/slice-key-selector.js";
import {
  compileRecallQueryProbes,
  type RecallQueryProbes
} from "../../recall/query/recall-query-probes.js";

function key(
  workspaceId: string,
  provenance: "query_probe" | "canonical_entity" | "object_anchor",
  freshness: "fresh" | "stale" = "fresh"
): SelectedSliceKeyV1 {
  return createSelectedSliceKeyV1({
    workspace_id: workspaceId,
    dimension: "entity",
    value: "ada lovelace",
    provenance: { kind: provenance, source_ref: `${provenance}:ada` },
    source_version: "v1",
    freshness: { state: freshness, as_of_ms: 1_720_000_000_000 }
  });
}

function routingKey(
  dimension: string,
  value: string,
  provenance: "query_probe" | "canonical_entity" | "facet_tag" | "event_time"
): SelectedSliceKeyV1 {
  return createSelectedSliceKeyV1({
    workspace_id: "workspace-a",
    dimension,
    value,
    provenance: { kind: provenance, source_ref: `${provenance}:${value}` },
    source_version: "v1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  });
}

function probes(
  overrides: Partial<RecallQueryProbes> = {}
): Readonly<RecallQueryProbes> {
  return Object.freeze({
    ...compileRecallQueryProbes(null),
    ...overrides
  });
}

function memory(
  overrides: Partial<MemoryEntry> = {}
): Readonly<MemoryEntry> {
  return {
    object_id: "memory-1",
    workspace_id: "workspace-a",
    updated_at: "2026-03-20T00:00:00.000Z",
    projection_schema_version: 1,
    facet_tags: null,
    canonical_entities: null,
    event_time_start: null,
    event_time_end: null,
    ...overrides
  } as Readonly<MemoryEntry>;
}

describe("slice-key selector", () => {
  it("passes through when the query has no fresh key", () => {
    const result = selectSliceCompatibilityV1({
      queryKeys: [key("workspace-a", "query_probe", "stale")],
      sourceKeys: [key("workspace-a", "canonical_entity")],
      targetKeys: [key("workspace-a", "object_anchor")]
    });

    expect(result).toEqual({
      decision: "pass_through",
      reason: "no_query_key",
      matches: []
    });
  });

  it.each([
    [[], [key("workspace-a", "object_anchor")], "missing_source_key"],
    [[key("workspace-a", "canonical_entity")], [], "missing_target_key"],
    [[], [], "missing_source_and_target_key"]
  ] as const)(
    "passes through when a routed endpoint projection is unavailable: %s / %s",
    (sourceKeys, targetKeys, reason) => {
      expect(selectSliceCompatibilityV1({
        queryKeys: [key("workspace-a", "query_probe")],
        sourceKeys,
        targetKeys
      })).toEqual({ decision: "pass_through", reason, matches: [] });
    }
  );

  it("accepts only a fresh three-way match", () => {
    const result = selectSliceCompatibilityV1({
      queryKeys: [key("workspace-a", "query_probe")],
      sourceKeys: [key("workspace-a", "canonical_entity")],
      targetKeys: [key("workspace-a", "object_anchor")]
    });

    expect(result.decision).toBe("compatible");
    expect(result.reason).toBe("slice_match");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.query_keys[0]?.provenance.kind).toBe("query_probe");
    expect(result.matches[0]?.source_keys[0]?.provenance.kind).toBe("canonical_entity");
    expect(result.matches[0]?.target_keys[0]?.provenance.kind).toBe("object_anchor");
  });

  it("treats an off-workspace endpoint key as unavailable", () => {
    const result = selectSliceCompatibilityV1({
      queryKeys: [key("workspace-a", "query_probe")],
      sourceKeys: [key("workspace-a", "canonical_entity")],
      targetKeys: [key("workspace-b", "object_anchor")]
    });

    expect(result).toEqual({
      decision: "pass_through",
      reason: "missing_target_key",
      matches: []
    });
  });

  it("rejects a comparable disjoint dimension even when another is unavailable", () => {
    const result = selectSliceCompatibilityV1({
      queryKeys: [
        routingKey("time", "day:2026-03-19", "query_probe"),
        routingKey("entity", "ada", "query_probe"),
        routingKey("semantic", "travel", "query_probe")
      ],
      sourceKeys: [
        routingKey("time", "day:2026-03-19", "event_time"),
        routingKey("entity", "ada", "canonical_entity"),
        routingKey("semantic", "travel", "facet_tag")
      ],
      targetKeys: [
        routingKey("time", "day:2026-03-20", "event_time"),
        routingKey("semantic", "travel", "facet_tag")
      ]
    });

    expect(result).toEqual({ decision: "rejected", reason: "no_slice_match", matches: [] });
  });

  it("rejects comparable keys whose values are disjoint", () => {
    expect(selectSliceCompatibilityV1({
      queryKeys: [routingKey("entity", "ada", "query_probe")],
      sourceKeys: [routingKey("entity", "ada", "canonical_entity")],
      targetKeys: [routingKey("entity", "grace", "canonical_entity")]
    })).toEqual({ decision: "rejected", reason: "no_slice_match", matches: [] });
  });

  it("uses OR within a dimension and AND across routed dimensions", () => {
    const result = selectSliceCompatibilityV1({
      queryKeys: [
        routingKey("time", "day:2026-03-19", "query_probe"),
        routingKey("entity", "ada", "query_probe"),
        routingKey("entity", "grace", "query_probe")
      ],
      sourceKeys: [
        routingKey("time", "day:2026-03-19", "event_time"),
        routingKey("entity", "grace", "canonical_entity")
      ],
      targetKeys: [
        routingKey("time", "day:2026-03-19", "event_time"),
        routingKey("entity", "grace", "canonical_entity")
      ]
    });

    expect(result.decision).toBe("compatible");
    expect(result.matches).toHaveLength(2);
  });

  it("uses semantic facets only when the query has no strong key", () => {
    const result = selectSliceCompatibilityV1({
      queryKeys: [routingKey("semantic", "travel", "query_probe")],
      sourceKeys: [routingKey("semantic", "travel", "facet_tag")],
      targetKeys: [routingKey("semantic", "travel", "facet_tag")]
    });

    expect(result.decision).toBe("compatible");
    expect(result.matches).toHaveLength(1);
  });
});

describe("slice-key read-time derivation", () => {
  it("keeps query facets and event time typed without routing on memory-entry ids", () => {
    const keys = deriveQuerySliceKeysV1({
      workspaceId: "workspace-a",
      queryProbes: probes({
        normalized_query: "where was object_memory-1 on 2026-03-19",
        object_ids: ["memory-1"],
        date_terms: ["2026-03-19"]
      }),
      asOfMs: 1_773_964_800_000
    });

    expect(keys.map(({ dimension, normalized_value }) => [dimension, normalized_value]))
      .toEqual([
        ["semantic", "location_place"],
        ["time", "day:2026-03-19"],
        ["time", "month:2026-03"]
      ]);
    expect(
      keys
        .filter((item) => item.dimension === "time")
        .every((item) => item.provenance.kind === "query_probe")
    ).toBe(true);
  });

  it("derives current memory projections without flattening event time into facets", () => {
    const keys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        facet_tags: [
          { facet: "location_place", value: " Paris " },
          { facet: "food_dining" }
        ],
        canonical_entities: ["Ada Lovelace"],
        event_time_start: "2026-03-19T09:30:00.000Z",
        event_time_end: "2026-03-19T10:30:00.000Z"
      }),
      asOfMs: 1_773_964_800_000
    });

    expect(keys.map(({ dimension, normalized_value }) => [dimension, normalized_value]))
      .toEqual([
        ["entity", "ada lovelace"],
        ["semantic", "food_dining"],
        ["semantic", "location_place"],
        ["space", "paris"],
        ["time", "day:2026-03-19"],
        ["time", "month:2026-03"]
      ]);
    expect(
      keys
        .filter((item) => item.dimension === "time")
        .every((item) => item.provenance.kind === "event_time")
    ).toBe(true);
  });

  it("does not infer space from an unvalued location facet", () => {
    const keys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({ facet_tags: [{ facet: "location_place", value: "  " }] }),
      asOfMs: 1_773_964_800_000
    });

    expect(keys.some((item) => item.dimension === "space")).toBe(false);
    expect(keys.some((item) => item.normalized_value === "location_place")).toBe(true);
  });

  it("fails closed for workspace mismatch and invalid or excessive intervals", () => {
    const mismatched = deriveMemorySliceKeysV1({
      workspaceId: "workspace-b",
      entry: memory({ canonical_entities: ["ada"] }),
      asOfMs: 1_773_964_800_000
    });
    const reversed = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        event_time_start: "2026-03-20T00:00:00.000Z",
        event_time_end: "2026-03-19T00:00:00.000Z"
      }),
      asOfMs: 1_773_964_800_000
    });
    const excessive = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        event_time_start: "2000-01-01T00:00:00.000Z",
        event_time_end: "2026-03-19T00:00:00.000Z"
      }),
      asOfMs: 1_773_964_800_000
    });

    expect(mismatched).toEqual([]);
    expect(reversed.some((item) => item.dimension === "time")).toBe(false);
    expect(excessive.some((item) => item.dimension === "time")).toBe(false);
  });

  it("uses month buckets for long bounded intervals", () => {
    const keys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        event_time_start: "2026-01-01T00:00:00.000Z",
        event_time_end: "2026-03-19T00:00:00.000Z"
      }),
      asOfMs: 1_773_964_800_000
    });
    const timeValues = keys
      .filter((item) => item.dimension === "time")
      .map((item) => item.normalized_value);

    expect(timeValues).toEqual([
      "month:2026-01",
      "month:2026-02",
      "month:2026-03"
    ]);
  });

  it("retains typed Path anchor provenance without inventing shared endpoints", () => {
    const objectKeys = derivePathAnchorSliceKeysV1({
      workspaceId: "workspace-a",
      pathId: "path-1",
      side: "source",
      anchor: { kind: "object_facet", object_id: "memory-1", facet_key: "food_dining" },
      sourceVersion: "2026-03-20T00:00:00.000Z",
      asOfMs: 1_773_964_800_000
    });
    const timeKeys = derivePathAnchorSliceKeysV1({
      workspaceId: "workspace-a",
      pathId: "path-1",
      side: "target",
      anchor: {
        kind: "time_concern",
        source_object_id: "memory-2",
        window_digest: "window-digest-1"
      },
      sourceVersion: "2026-03-20T00:00:00.000Z",
      asOfMs: 1_773_964_800_000
    });

    expect(objectKeys.map((item) => [item.dimension, item.normalized_value])).toEqual([
      ["semantic", "food_dining"]
    ]);
    expect(objectKeys.map((item) => item.provenance.kind)).toEqual(["path_facet"]);
    expect(timeKeys.map((item) => [item.dimension, item.normalized_value])).toEqual([
      ["time", "concern:window-digest-1"]
    ]);
    expect(timeKeys[0]?.provenance.kind).toBe("time_concern");
  });

  it("rejects invalid query calendar months instead of normalizing them", () => {
    const keys = deriveQuerySliceKeysV1({
      workspaceId: "workspace-a",
      queryProbes: probes({ date_terms: ["2026-13"] }),
      asOfMs: 1_773_964_800_000
    });

    expect(keys).toEqual([]);
  });

  it("does not turn arbitrary lexical terms into entity or space keys", () => {
    const keys = deriveQuerySliceKeysV1({
      workspaceId: "workspace-a",
      queryProbes: probes({
        normalized_query: "tell me about mysteryville",
        lexical_terms: ["mysteryville"]
      }),
      asOfMs: 1_773_964_800_000
    });

    expect(keys.some((item) => item.dimension === "entity")).toBe(false);
    expect(keys.some((item) => item.dimension === "space")).toBe(false);
  });

  it("rebuilds from replacement and cleared projections without stale state", () => {
    const original = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        updated_at: "2026-03-19T00:00:00.000Z",
        facet_tags: [{ facet: "food_dining" }],
        canonical_entities: ["ada"]
      }),
      asOfMs: 1_773_964_800_000
    });
    const replaced = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        updated_at: "2026-03-20T00:00:00.000Z",
        facet_tags: [{ facet: "travel" }],
        canonical_entities: ["grace"]
      }),
      asOfMs: 1_773_964_800_000
    });
    const cleared = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        updated_at: "2026-03-21T00:00:00.000Z",
        facet_tags: null,
        canonical_entities: null
      }),
      asOfMs: 1_773_964_800_000
    });

    expect(original.some((item) => item.normalized_value === "food_dining")).toBe(true);
    expect(replaced.some((item) => item.normalized_value === "food_dining")).toBe(false);
    expect(replaced.some((item) => item.normalized_value === "ada")).toBe(false);
    expect(cleared).toEqual([]);
  });

  it("matches query and memory event-time buckets through the same UTC representation", () => {
    const queryKeys = deriveQuerySliceKeysV1({
      workspaceId: "workspace-a",
      queryProbes: probes({ date_terms: ["2026-03-19"] }),
      asOfMs: 1_773_964_800_000
    });
    const sourceKeys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        object_id: "memory-source",
        event_time_start: "2026-03-19T01:00:00.000Z"
      }),
      asOfMs: 1_773_964_800_000
    });
    const targetKeys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        object_id: "memory-target",
        event_time_start: "2026-03-19T22:00:00.000Z"
      }),
      asOfMs: 1_773_964_800_000
    });

    const result = selectSliceCompatibilityV1({ queryKeys, sourceKeys, targetKeys });
    expect(result.decision).toBe("compatible");
    expect(result.matches.map((match) => match.match_id)).toHaveLength(2);
  });

  it("does not turn internal memory-entry ids into query routing keys", () => {
    const queryKeys = deriveQuerySliceKeysV1({
      workspaceId: "workspace-a",
      queryProbes: probes({ object_ids: ["memory-source"] }),
      asOfMs: 1_773_964_800_000
    });
    const sourceKeys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({ object_id: "memory-source" }),
      asOfMs: 1_773_964_800_000
    });
    const targetKeys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({ object_id: "memory-target" }),
      asOfMs: 1_773_964_800_000
    });

    expect(queryKeys).toEqual([]);
    expect(selectSliceCompatibilityV1({ queryKeys, sourceKeys, targetKeys }).reason)
      .toBe("no_query_key");
  });

  it("is deterministic under query, source, and target input permutation", () => {
    const queryKeys = [
      key("workspace-a", "query_probe"),
      createSelectedSliceKeyV1({
        workspace_id: "workspace-a",
        dimension: "semantic",
        value: "travel",
        provenance: { kind: "query_probe", source_ref: "query:travel" },
        source_version: "v1",
        freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
      })
    ];
    const sourceKeys = [key("workspace-a", "canonical_entity")];
    const targetKeys = [key("workspace-a", "object_anchor")];

    const first = selectSliceCompatibilityV1({ queryKeys, sourceKeys, targetKeys });
    const second = selectSliceCompatibilityV1({
      queryKeys: [...queryKeys].reverse(),
      sourceKeys: [...sourceKeys].reverse(),
      targetKeys: [...targetKeys].reverse()
    });

    expect(second).toEqual(first);
  });

  it("uses the contract's locale-independent key identity ordering", () => {
    const keys = deriveMemorySliceKeysV1({
      workspaceId: "workspace-a",
      entry: memory({
        facet_tags: [
          { facet: "ä" },
          { facet: "z" }
        ]
      }),
      asOfMs: 1_773_964_800_000
    });

    expect(
      keys
        .filter((item) => item.dimension === "semantic")
        .map((item) => item.normalized_value)
    ).toEqual(["z", "ä"]);
  });
});
