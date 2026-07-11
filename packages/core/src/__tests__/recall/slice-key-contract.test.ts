import { describe, expect, it } from "vitest";

import {
  createSelectedSliceKeyV1,
  intersectSelectedSliceKeysV1,
  normalizeSelectedSliceKeysV1,
  SELECTED_SLICE_KEY_V1_SEED_DIMENSIONS,
  type SelectedSliceKeyInputV1,
  type SelectedSliceKeyProvenanceKindV1
} from "../../recall/flood/slice-key-contract.js";

function keyInput(
  provenanceKind: SelectedSliceKeyProvenanceKindV1,
  overrides: Partial<SelectedSliceKeyInputV1> = {}
): SelectedSliceKeyInputV1 {
  return {
    workspace_id: "workspace-A",
    dimension: "entity",
    value: "Ada Lovelace",
    provenance: { kind: provenanceKind, source_ref: `ref:${provenanceKind}` },
    source_version: "version-1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 },
    ...overrides
  };
}

describe("SelectedSliceKeyV1", () => {
  it("separates rebuild identity from routing identity", () => {
    const eventTime = createSelectedSliceKeyV1({
      workspace_id: "workspace-A",
      dimension: "time",
      value: "  CAFE\u0301  ",
      provenance: { kind: "event_time", source_ref: "memory-1:event-time" },
      source_version: "projection-7",
      freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
    });
    const timeConcern = createSelectedSliceKeyV1({
      workspace_id: "workspace-A",
      dimension: "time",
      value: "caf\u00e9",
      provenance: { kind: "time_concern", source_ref: "path-2:window" },
      source_version: "path-4",
      freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
    });

    expect(eventTime.normalized_value).toBe("caf\u00e9");
    expect(eventTime.match_id).toBe(timeConcern.match_id);
    expect(eventTime.key_id).not.toBe(timeConcern.key_id);
    expect(JSON.parse(eventTime.match_id)).toEqual(["workspace-A", "time", "caf\u00e9"]);
    expect(JSON.parse(eventTime.key_id)).toEqual([
      1,
      "workspace-A",
      "time",
      "caf\u00e9",
      "event_time",
      "memory-1:event-time",
      "projection-7"
    ]);
  });

  it("rejects invalid identity and freshness inputs", () => {
    for (const invalid of [
      keyInput("canonical_entity", { workspace_id: "  " }),
      keyInput("canonical_entity", { dimension: " " }),
      keyInput("canonical_entity", { value: "\t" }),
      keyInput("canonical_entity", { source_version: "" }),
      keyInput("canonical_entity", {
        provenance: { kind: "canonical_entity", source_ref: " " }
      }),
      keyInput("canonical_entity", { freshness: { state: "fresh", as_of_ms: -1 } })
    ]) {
      expect(() => createSelectedSliceKeyV1(invalid)).toThrow();
    }

    expect(() =>
      createSelectedSliceKeyV1({
        ...keyInput("canonical_entity"),
        provenance: { kind: "unknown" as SelectedSliceKeyProvenanceKindV1, source_ref: "x" }
      })
    ).toThrow(/provenance\.kind/);
  });

  it("does not collapse typed event-time into semantic facet provenance", () => {
    expect(() =>
      createSelectedSliceKeyV1(keyInput("event_time", { dimension: "semantic" }))
    ).toThrow(/event_time.*time/);
    expect(() =>
      createSelectedSliceKeyV1(keyInput("facet_tag", { dimension: "time" }))
    ).toThrow(/facet_tag.*semantic/);

    expect(
      createSelectedSliceKeyV1(keyInput("event_time", { dimension: "time" })).provenance.kind
    ).toBe("event_time");
  });

  it("keeps v1 producers typed without closing future routing dimensions", () => {
    expect(SELECTED_SLICE_KEY_V1_SEED_DIMENSIONS).toEqual([
      "time",
      "space",
      "entity",
      "semantic"
    ]);
    const extended = createSelectedSliceKeyV1(
      keyInput("query_probe", { dimension: "future-routing-axis" })
    );
    expect(extended.dimension).toBe("future-routing-axis");
  });

  it("tracks staleness without making freshness part of rebuild identity", () => {
    const fresh = createSelectedSliceKeyV1(keyInput("canonical_entity"));
    const stale = createSelectedSliceKeyV1(
      keyInput("canonical_entity", { freshness: { state: "stale", as_of_ms: 1_730_000_000_000 } })
    );
    const newerSource = createSelectedSliceKeyV1(
      keyInput("canonical_entity", { source_version: "version-2" })
    );

    expect(stale.freshness.state).toBe("stale");
    expect(stale.key_id).toBe(fresh.key_id);
    expect(newerSource.key_id).not.toBe(fresh.key_id);
  });

  it("sorts and deduplicates by collision-safe key identity", () => {
    const entity = keyInput("canonical_entity", {
      workspace_id: "workspace:A",
      value: "B:C"
    });
    const entityDuplicate = { ...entity };
    const query = keyInput("query_probe", { workspace_id: "workspace:A", value: "b:c" });
    const first = normalizeSelectedSliceKeysV1([query, entityDuplicate, entity]);
    const second = normalizeSelectedSliceKeysV1([entity, query, entityDuplicate]);

    expect(first.map((key) => key.key_id)).toEqual(second.map((key) => key.key_id));
    expect(first).toHaveLength(2);
    expect(first.map((key) => key.provenance.kind).sort()).toEqual([
      "canonical_entity",
      "query_probe"
    ]);
    expect(new Set(first.map((key) => key.match_id)).size).toBe(1);
  });

  it("keeps the newest duplicate freshness and prefers a usable fresh tie", () => {
    const older = keyInput("canonical_entity", {
      freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
    });
    const newer = keyInput("canonical_entity", {
      freshness: { state: "fresh", as_of_ms: 1_730_000_000_000 }
    });
    const tiedStale = keyInput("canonical_entity", {
      freshness: { state: "stale", as_of_ms: 1_730_000_000_000 }
    });

    const forward = normalizeSelectedSliceKeysV1([older, newer, tiedStale]);
    const reverse = normalizeSelectedSliceKeysV1([tiedStale, newer, older]);
    expect(forward).toEqual(reverse);
    expect(forward).toHaveLength(1);
    expect(forward[0]?.freshness).toEqual({
      state: "fresh",
      as_of_ms: 1_730_000_000_000
    });
  });

  it("intersects by match identity while retaining each source instance", () => {
    const query = [createSelectedSliceKeyV1(keyInput("query_probe"))];
    const source = [createSelectedSliceKeyV1(keyInput("canonical_entity"))];
    const target = [createSelectedSliceKeyV1(keyInput("object_anchor"))];
    const offWorkspace = createSelectedSliceKeyV1(
      keyInput("object_anchor", { workspace_id: "workspace-B" })
    );
    const matches = intersectSelectedSliceKeysV1(query, source, [...target, offWorkspace]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.query_keys.map((key) => key.provenance.kind)).toEqual(["query_probe"]);
    expect(matches[0]?.source_keys.map((key) => key.provenance.kind)).toEqual([
      "canonical_entity"
    ]);
    expect(matches[0]?.target_keys.map((key) => key.provenance.kind)).toEqual([
      "object_anchor"
    ]);
  });
});
