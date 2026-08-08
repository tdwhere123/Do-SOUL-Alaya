import { describe, expect, it } from "vitest";

import {
  buildMonotoneFieldRefinementLevels,
  preserveFieldLaneObservationPrefix
} from
  "../../../repos/shared/monotone-field-refinement.js";

describe("monotone field refinement", () => {
  it("preserves observed identities when deeper ranking inserts new owners", () => {
    const base = Object.freeze([
      Object.freeze({ object_id: "memory-a", normalized_rank: 1 }),
      Object.freeze({ object_id: "memory-b", normalized_rank: 0.5 })
    ]);
    const levels = buildMonotoneFieldRefinementLevels(
      base,
      [4],
      () => Object.freeze({
        matches: Object.freeze([
          Object.freeze({ object_id: "memory-c", normalized_rank: 1 }),
          Object.freeze({ object_id: "memory-a", normalized_rank: 0.75 }),
          Object.freeze({ object_id: "memory-d", normalized_rank: 0.5 }),
          Object.freeze({ object_id: "memory-b", normalized_rank: 0.25 })
        ]),
        lanes: Object.freeze(["porter", "trigram"])
      })
    );

    expect(levels).toEqual([{
      requested_depth: 4,
      matches: [
        { object_id: "memory-a", normalized_rank: 0.75 },
        { object_id: "memory-b", normalized_rank: 0.25 },
        { object_id: "memory-c", normalized_rank: 1 },
        { object_id: "memory-d", normalized_rank: 0.5 }
      ],
      lanes: ["porter", "trigram"]
    }]);
  });

  it("keeps an observed projection representative for one owner", () => {
    const base = Object.freeze([Object.freeze({
      object_id: "evidence-a",
      normalized_rank: 1,
      matched_projection: Object.freeze({
        projection_id: 1,
        projection_kind: "assistant_observation"
      })
    })]);
    const levels = buildMonotoneFieldRefinementLevels(
      base,
      [2],
      () => Object.freeze({
        matches: Object.freeze([
          Object.freeze({
            object_id: "evidence-a",
            normalized_rank: 1,
            matched_projection: Object.freeze({
              projection_id: 2,
              projection_kind: "fact_key"
            })
          }),
          Object.freeze({ object_id: "evidence-b", normalized_rank: 0.5 })
        ]),
        lanes: Object.freeze([])
      })
    );

    expect(levels[0]?.matches).toEqual([
      base[0],
      { object_id: "evidence-b", normalized_rank: 0.5 }
    ]);
  });

  it("preserves lane source identities and rebases appended ranks", () => {
    const previous = Object.freeze([Object.freeze({
      object_id: "evidence-a",
      normalized_rank: 1,
      rank: 1,
      source_id: "projection:evidence-a:assistant_observation:1"
    })]);
    const next = Object.freeze([
      Object.freeze({
        object_id: "evidence-b",
        normalized_rank: 1,
        rank: 1,
        source_id: "owner:evidence-b"
      }),
      Object.freeze({
        object_id: "evidence-a",
        normalized_rank: 0.5,
        rank: 2,
        source_id: "projection:evidence-a:assistant_observation:1"
      })
    ]);

    expect(preserveFieldLaneObservationPrefix(previous, next)).toEqual([
      {
        object_id: "evidence-a",
        normalized_rank: 0.5,
        rank: 1,
        source_id: "projection:evidence-a:assistant_observation:1"
      },
      {
        object_id: "evidence-b",
        normalized_rank: 1,
        rank: 2,
        source_id: "owner:evidence-b"
      }
    ]);
  });
});
