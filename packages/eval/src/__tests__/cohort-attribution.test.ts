import { describe, expect, it } from "vitest";
import {
  computePlaneAttribution,
  extractPlaneAttributionRows,
  shareOfPlane,
  type PlaneAttributionRow
} from "../cohort-attribution.js";

describe("computePlaneAttribution", () => {
  it("returns empty result when no rows hit", () => {
    const rows: readonly PlaneAttributionRow[] = [
      {
        question_id: "q1",
        hit_at_5: false,
        plane_winning_admission: null
      },
      {
        question_id: "q2",
        hit_at_5: false,
        plane_winning_admission: "lexical"
      }
    ];
    const result = computePlaneAttribution(rows);
    expect(result.total_hits).toBe(0);
    expect(result.attributed_hits).toBe(0);
    expect(result.unattributed_hits).toBe(0);
    expect(result.shares).toEqual([]);
  });

  it("rolls up shares per plane in descending hit order", () => {
    const rows: readonly PlaneAttributionRow[] = [
      { question_id: "q1", hit_at_5: true, plane_winning_admission: "lexical" },
      { question_id: "q2", hit_at_5: true, plane_winning_admission: "lexical" },
      { question_id: "q3", hit_at_5: true, plane_winning_admission: "lexical" },
      { question_id: "q4", hit_at_5: true, plane_winning_admission: "evidence_anchor" },
      { question_id: "q5", hit_at_5: true, plane_winning_admission: "session_surface_cohort" },
      { question_id: "q6", hit_at_5: false, plane_winning_admission: null }
    ];
    const result = computePlaneAttribution(rows);
    expect(result.total_hits).toBe(5);
    expect(result.attributed_hits).toBe(5);
    expect(result.unattributed_hits).toBe(0);
    expect(result.shares).toEqual([
      { plane: "lexical", hits: 3, share: 0.6 },
      { plane: "evidence_anchor", hits: 1, share: 0.2 },
      { plane: "session_surface_cohort", hits: 1, share: 0.2 }
    ]);
  });

  it("counts hits with null plane as unattributed", () => {
    const rows: readonly PlaneAttributionRow[] = [
      { question_id: "q1", hit_at_5: true, plane_winning_admission: "lexical" },
      { question_id: "q2", hit_at_5: true, plane_winning_admission: null }
    ];
    const result = computePlaneAttribution(rows);
    expect(result.total_hits).toBe(2);
    expect(result.attributed_hits).toBe(1);
    expect(result.unattributed_hits).toBe(1);
    expect(result.shares).toEqual([
      { plane: "lexical", hits: 1, share: 0.5 }
    ]);
  });

  it("flags cohort-plane domination via shareOfPlane", () => {
    const cohortDominated: PlaneAttributionRow[] = [];
    for (let i = 0; i < 60; i++) {
      cohortDominated.push({
        question_id: `q-cohort-${i}`,
        hit_at_5: true,
        plane_winning_admission: "session_surface_cohort"
      });
    }
    for (let i = 0; i < 40; i++) {
      cohortDominated.push({
        question_id: `q-other-${i}`,
        hit_at_5: true,
        plane_winning_admission: "lexical"
      });
    }
    const result = computePlaneAttribution(cohortDominated);
    expect(shareOfPlane(result, "session_surface_cohort")).toBeGreaterThan(0.5);
    expect(shareOfPlane(result, "lexical")).toBe(0.4);
    expect(shareOfPlane(result, "graph_expansion")).toBe(0);
  });
});

describe("extractPlaneAttributionRows", () => {
  it("reads plane_winning_admission off the top-level field when present", () => {
    const rows = extractPlaneAttributionRows([
      {
        question_id: "q1",
        hit_at_5: true,
        plane_winning_admission: "lexical"
      }
    ]);
    expect(rows).toEqual([
      { question_id: "q1", hit_at_5: true, plane_winning_admission: "lexical" }
    ]);
  });

  it("falls back to gold[].plane_winning_admission for delivered gold within rank 5", () => {
    const rows = extractPlaneAttributionRows([
      {
        question_id: "q1",
        hit_at_5: true,
        gold: [
          {
            object_id: "g1",
            candidate_status: "delivered",
            final_rank: 2,
            plane_winning_admission: "path_expansion"
          }
        ]
      }
    ]);
    expect(rows[0]?.plane_winning_admission).toBe("path_expansion");
  });

  it("returns null plane when no delivered gold within top-5 carries a plane", () => {
    const rows = extractPlaneAttributionRows([
      {
        question_id: "q1",
        hit_at_5: true,
        gold: [
          {
            object_id: "g1",
            candidate_status: "delivered",
            final_rank: 7,
            plane_winning_admission: "graph_expansion"
          }
        ]
      }
    ]);
    expect(rows[0]?.plane_winning_admission).toBeNull();
  });

  it("skips non-object entries silently", () => {
    const rows = extractPlaneAttributionRows([
      null,
      undefined,
      "string",
      42,
      { question_id: "ok", hit_at_5: false }
    ]);
    expect(rows).toEqual([
      { question_id: "ok", hit_at_5: false, plane_winning_admission: null }
    ]);
  });
});
