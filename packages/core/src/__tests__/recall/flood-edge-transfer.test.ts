import { describe, expect, it } from "vitest";

import {
  computeFloodEdgeTransfer,
  RECALL_FLOOD_EDGE_TRACE_LIMIT
} from "../../recall/flood/edge-transfer.js";
import type { SliceCompatibilityV1 } from "../../recall/flood/slice-key-selector.js";
import { noisyOrDecorrelate } from "../../recall/scoring/conformant-evidence-math.js";
import type { PathInflowEdge } from "../../recall/runtime/recall-service-types.js";

function edge(
  pathId: string,
  seedObjectId: string,
  targetObjectId: string,
  weight: number,
  overrides: Partial<PathInflowEdge> = {}
): PathInflowEdge {
  return {
    pathId,
    relationKind: "answers_with",
    seedObjectId,
    targetObjectId,
    seedAnchor: { kind: "object", object_id: seedObjectId },
    targetAnchor: { kind: "object", object_id: targetObjectId },
    pathSourceVersion: "2026-07-10T00:00:00.000Z",
    weight,
    ...overrides
  };
}

describe("flood edge transfer trace", () => {
  it("records transferred and rejected edge decisions without changing transfer math", () => {
    const result = computeFloodEdgeTransfer({
      inflow: [
        edge("path-transfer", "seed", "target", 0.5),
        edge("path-self", "target", "target", 1),
        edge("path-no-input", "missing", "target", 1),
        edge("path-no-conductance", "seed", "target", 0)
      ],
      targetObjectId: "target",
      rObjectById: new Map([["seed", 0.8], ["target", 0.9]]),
      capPerSource: 0.3,
      capTotal: 3,
      rhoPath: 0.5
    });

    expect(result.value).toBeCloseTo(0.3, 15);
    expect(result.traces).toEqual([
      expect.objectContaining({
        path_id: "path-self",
        decision: "rejected",
        reason: "self_loop"
      }),
      expect.objectContaining({
        schema_version: 1,
        path_id: "path-no-conductance",
        input_potential: 0.8,
        edge_conductance: 0,
        raw_transfer: 0,
        capped_transfer: 0,
        decision: "rejected",
        reason: "non_positive_conductance",
        slice_compatibility: "not_evaluated"
      }),
      expect.objectContaining({
        path_id: "path-no-input",
        input_potential: 0,
        decision: "rejected",
        reason: "missing_or_zero_input"
      }),
      expect.objectContaining({
        path_id: "path-transfer",
        raw_transfer: 0.4,
        capped_transfer: 0.3,
        decision: "transferred",
        reason: "capped"
      })
    ]);
    expect(result.truncatedCount).toBe(0);
  });

  it("sorts trace provenance before applying the fixed candidate bound", () => {
    const inflow = Array.from({ length: RECALL_FLOOD_EDGE_TRACE_LIMIT + 2 }, (_, index) =>
      edge(`path-${String(index).padStart(2, "0")}`, `seed-${index}`, "target", 0)
    ).reverse();
    const result = computeFloodEdgeTransfer({
      inflow,
      targetObjectId: "target",
      rObjectById: new Map(),
      capPerSource: 1,
      capTotal: 3,
      rhoPath: 0.5
    });

    expect(result.traces).toHaveLength(RECALL_FLOOD_EDGE_TRACE_LIMIT);
    expect(result.traces[0]?.path_id).toBe("path-00");
    expect(result.traces.at(-1)?.path_id).toBe("path-15");
    expect(result.truncatedCount).toBe(2);
  });

  it("keeps the pre-trace collapse result byte-equivalent", () => {
    const inflow = [
      edge("path-a", "seed-a", "target", 0.37),
      edge("path-b", "seed-b", "target", 0.83),
      edge("path-c", "missing", "target", 1),
      edge("path-d", "target", "target", 1)
    ];
    const potentials = new Map([["seed-a", 0.123456789], ["seed-b", 0.987654321]]);
    const expected = legacyCollapse(inflow, "target", potentials, 0.5, 0.9, 0.41);
    const actual = computeFloodEdgeTransfer({
      inflow,
      targetObjectId: "target",
      rObjectById: potentials,
      capPerSource: 0.5,
      capTotal: 0.9,
      rhoPath: 0.41
    }).value;

    expect(Object.is(actual, expected)).toBe(true);
  });

  it("keeps default-off traces and collapse arithmetic for values above one", () => {
    const inflow = [edge("path-a", "seed", "target", 1.5)];
    const potentials = new Map([["seed", 1.4]]);
    const result = computeFloodEdgeTransfer({
      inflow, targetObjectId: "target", rObjectById: potentials,
      capPerSource: 3, capTotal: 3, rhoPath: 0.5
    });

    expect(Object.is(result.value, legacyCollapse(
      inflow, "target", potentials, 3, 3, 0.5
    ))).toBe(true);
    expect(result.traces[0]).toMatchObject({
      input_potential: 1.4,
      edge_conductance: 1.5,
      raw_transfer: 2.0999999999999996,
      capped_transfer: 2.0999999999999996
    });
  });

  it.each([0, -0.25])("rejects a non-positive per-source cap in trace and aggregate", (capPerSource) => {
    const inflow = [edge("path-a", "seed", "target", 0.5)];
    const potentials = new Map([["seed", 0.8]]);
    const result = computeFloodEdgeTransfer({
      inflow,
      targetObjectId: "target",
      rObjectById: potentials,
      capPerSource,
      capTotal: 1,
      rhoPath: 0.5
    });

    expect(Object.is(result.value, legacyCollapse(
      inflow, "target", potentials, capPerSource, 1, 0.5
    ))).toBe(true);
    expect(result.traces[0]).toMatchObject({
      raw_transfer: 0.4,
      capped_transfer: 0,
      decision: "rejected",
      reason: "capped"
    });
  });

  it("rejects an edge transfer that underflows to zero", () => {
    const result = computeFloodEdgeTransfer({
      inflow: [edge("path-a", "seed", "target", Number.MIN_VALUE)],
      targetObjectId: "target",
      rObjectById: new Map([["seed", Number.MIN_VALUE]]),
      capPerSource: 1,
      capTotal: 1,
      rhoPath: 0.5
    });

    expect(result.value).toBe(0);
    expect(result.traces[0]).toMatchObject({
      raw_transfer: 0,
      capped_transfer: 0,
      decision: "rejected",
      reason: "missing_or_zero_input"
    });
  });

  it("observes a slice mismatch without changing default transfer math", () => {
    const inflow = [edge("path-a", "seed", "target", 0.5)];
    const potentials = new Map([["seed", 0.8]]);
    const expected = legacyCollapse(inflow, "target", potentials, 1, 3, 0.5);
    const result = computeFloodEdgeTransfer({
      inflow,
      targetObjectId: "target",
      rObjectById: potentials,
      capPerSource: 1,
      capTotal: 3,
      rhoPath: 0.5,
      sliceCompatibilityByPathId: new Map([[
        "path-a",
        { decision: "rejected", reason: "no_slice_match", matches: [] }
      ]])
    });

    expect(Object.is(result.value, expected)).toBe(true);
    expect(result.traces[0]).toEqual(expect.objectContaining({
      slice_compatibility: "no_slice_match",
      decision: "transferred",
      reason: "transferred"
    }));
  });

  it("rejects only the mismatched edge when call-level slice enforcement is enabled", () => {
    const result = computeFloodEdgeTransfer({
      inflow: [edge("path-a", "seed", "target", 0.5)],
      targetObjectId: "target",
      rObjectById: new Map([["seed", 0.8]]),
      capPerSource: 1,
      capTotal: 3,
      rhoPath: 0.5,
      enforceSliceCompatibility: true,
      sliceCompatibilityByPathId: new Map([[
        "path-a",
        { decision: "rejected", reason: "no_slice_match", matches: [] }
      ]])
    });

    expect(result.value).toBe(0);
    expect(result.traces[0]).toEqual(expect.objectContaining({
      slice_compatibility: "no_slice_match",
      capped_transfer: 0,
      decision: "rejected",
      reason: "no_slice_match"
    }));
  });

  it("records no_query_key as a neutral pass-through", () => {
    const result = computeFloodEdgeTransfer({
      inflow: [edge("path-a", "seed", "target", 0.5)],
      targetObjectId: "target",
      rObjectById: new Map([["seed", 0.8]]),
      capPerSource: 1,
      capTotal: 3,
      rhoPath: 0.5,
      enforceSliceCompatibility: true,
      sliceCompatibilityByPathId: new Map([[
        "path-a",
        { decision: "pass_through", reason: "no_query_key", matches: [] }
      ]])
    });

    expect(result.value).toBe(0.4);
    expect(result.traces[0]).toEqual(expect.objectContaining({
      slice_compatibility: "no_query_key",
      decision: "transferred"
    }));
  });

  it("records incomplete endpoint projection as a neutral pass-through", () => {
    const result = computeFloodEdgeTransfer({
      inflow: [edge("path-a", "seed", "target", 0.5)],
      targetObjectId: "target",
      rObjectById: new Map([["seed", 0.8]]),
      capPerSource: 1,
      capTotal: 3,
      rhoPath: 0.5,
      enforceSliceCompatibility: true,
      sliceCompatibilityByPathId: new Map([[
        "path-a",
        { decision: "pass_through", reason: "missing_target_key", matches: [] }
      ]])
    });

    expect(result.value).toBe(0.4);
    expect(result.traces[0]).toEqual(expect.objectContaining({
      slice_compatibility: "missing_target_key",
      decision: "transferred",
      reason: "transferred"
    }));
  });

  it("rejects missing or blank edge provenance when slice enforcement is enabled", () => {
    const invalidEdges = [
      edge("path-a", "seed", "target", 0.5, { pathId: undefined }),
      edge("path-a", "seed", "target", 0.5, { pathId: " " }),
      edge("path-a", "seed", "target", 0.5, { seedAnchor: undefined }),
      edge("path-a", "seed", "target", 0.5, { targetAnchor: undefined }),
      edge("path-a", "seed", "target", 0.5, { pathSourceVersion: undefined }),
      edge("path-a", "seed", "target", 0.5, { pathSourceVersion: " " })
    ];

    for (const invalidEdge of invalidEdges) {
      const result = computeFloodEdgeTransfer({
        inflow: [invalidEdge],
        targetObjectId: "target",
        rObjectById: new Map([["seed", 0.8]]),
        capPerSource: 1,
        capTotal: 3,
        rhoPath: 0.5,
        enforceSliceCompatibility: true
      });
      expect(result.value).toBe(0);
      expect(result.traces[0]).toEqual(expect.objectContaining({
        slice_compatibility: "not_evaluated",
        capped_transfer: 0,
        decision: "rejected",
        reason: "missing_edge_provenance"
      }));
    }
  });

  it("keeps missing provenance byte-equivalent on the default legacy path", () => {
    const invalidEdges = [
      edge("path-a", "seed", "target", 0.5, { pathId: undefined }),
      edge("path-a", "seed", "target", 0.5, { seedAnchor: undefined }),
      edge("path-a", "seed", "target", 0.5, { targetAnchor: undefined }),
      edge("path-a", "seed", "target", 0.5, { pathSourceVersion: undefined })
    ];
    const potentials = new Map([["seed", 0.8]]);

    for (const invalidEdge of invalidEdges) {
      const expected = legacyCollapse([invalidEdge], "target", potentials, 1, 3, 0.5);
      const result = computeFloodEdgeTransfer({
        inflow: [invalidEdge], targetObjectId: "target", rObjectById: potentials,
        capPerSource: 1, capTotal: 3, rhoPath: 0.5
      });
      expect(Object.is(result.value, expected)).toBe(true);
      expect(result.traces[0]?.decision).toBe("transferred");
    }
  });

  it.each([false, true])(
    "aggregates every parallel directed edge when slice enforcement is %s",
    (enforceSliceCompatibility) => {
      const inflow = [
        edge("path-a", "seed", "target", 0.5),
        edge("path-b", "seed", "target", 0.25)
      ];
      const potentials = new Map([["seed", 0.8]]);
      const result = computeFloodEdgeTransfer({
        inflow,
        targetObjectId: "target",
        rObjectById: potentials,
        capPerSource: 1,
        capTotal: 1,
        rhoPath: 0.5,
        enforceSliceCompatibility,
        sliceCompatibilityByPathId: new Map([
          ["path-a", { decision: "compatible", reason: "slice_match", matches: [] }],
          ["path-b", { decision: "compatible", reason: "slice_match", matches: [] }]
        ])
      });

      const expected = legacyCollapse(inflow, "target", potentials, 1, 1, 0.5);
      expect(Object.is(result.value, expected)).toBe(true);
      expect(result.value).toBeCloseTo(0.46, 15);
      expect(result.traces).toHaveLength(2);
    }
  );

  it("keeps material diagnostics under truncation with deterministic input ordering", () => {
    const inflow = [
      edge("aa-low-transfer", "low", "target", 0.1),
      edge("zy-high-transfer", "high", "target", 0.8),
      edge("zz-material-rejection", "rejected", "target", 0.9)
    ];
    const input = {
      targetObjectId: "target",
      rObjectById: new Map([["low", 0.1], ["high", 0.8], ["rejected", 0.9]]),
      capPerSource: 1,
      capTotal: 1,
      rhoPath: 0.5,
      traceLimit: 2,
      enforceSliceCompatibility: true,
      sliceCompatibilityByPathId: new Map<string, SliceCompatibilityV1>([
        ["aa-low-transfer", { decision: "compatible", reason: "slice_match", matches: [] }],
        ["zy-high-transfer", { decision: "compatible", reason: "slice_match", matches: [] }],
        ["zz-material-rejection", { decision: "rejected", reason: "no_slice_match", matches: [] }]
      ])
    } as const;

    const forward = computeFloodEdgeTransfer({ ...input, inflow });
    const reversed = computeFloodEdgeTransfer({ ...input, inflow: [...inflow].reverse() });

    expect(forward.traces.map((trace) => trace.path_id)).toEqual([
      "zz-material-rejection",
      "zy-high-transfer"
    ]);
    expect(reversed.traces).toEqual(forward.traces);
    expect(forward.truncatedCount).toBe(1);
    expect(reversed.truncatedCount).toBe(1);
  });
});

function legacyCollapse(
  inflow: readonly PathInflowEdge[],
  targetObjectId: string,
  potentials: ReadonlyMap<string, number>,
  capPerSource: number,
  capTotal: number,
  rhoPath: number
): number {
  const supports: number[] = [];
  for (const candidate of inflow) {
    if (candidate.seedObjectId === targetObjectId) continue;
    const potential = potentials.get(candidate.seedObjectId);
    if (potential === undefined || potential <= 0 || candidate.weight <= 0) continue;
    supports.push(Math.min(potential * candidate.weight, capPerSource));
  }
  return Math.min(noisyOrDecorrelate(supports, supports.map(() => 1), rhoPath), capTotal);
}
