import { describe, expect, it } from "vitest";
import { OpenSemanticFactorGraphSchema } from "@do-soul/alaya-protocol";
import { materializeKindConstraintAlignment } from
  "../../../../recall/field/kind-projection/alignment.js";
import {
  T2_INVALID_KIND_VALUES_TOO_MANY,
  T2_INVALID_MALFORMED_PROJECTION,
  T2_INVALID_UNBOUND_FACTOR,
  T2_MISSING_KIND_PROJECTION,
  T2_MUSIC_STREAMING_SERVICE,
  T2_POLARITY_VIDEO_HOSTING,
  T2_SPOTIFY_MUSIC_STREAMING_HAPPY,
  T2_TWO_INSTANCES_SAME_KIND,
  T2_VIDEO_HOSTING,
  t2KindProposal,
  t2SpotifyEvidenceGraph,
  t2TwoInstanceEvidenceGraph
} from "./fixtures.js";

describe("kind_constraint_alignment_v1", () => {
  it(`${T2_SPOTIFY_MUSIC_STREAMING_HAPPY}: constraint plus valid projection keeps spotify`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph,
      kind_projections: [t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE])]
    });

    expect(result.operator_id).toBe("kind_constraint_alignment_v1");
    expect(result.status).toBe("formed");
    expect(result.alignments).toEqual([expect.objectContaining({
      variable_id: "answer",
      factor_id: "spotify",
      answer_identity: "spotify",
      kind_identity: T2_MUSIC_STREAMING_SERVICE
    })]);
    expect(result.alignments[0]?.answer_identity).not.toBe(T2_MUSIC_STREAMING_SERVICE);
    expect(result.projections[0]).toMatchObject({
      status: "formed",
      factor_id: "spotify",
      instance_of: [{
        predicate: "instance_of",
        kind_identity: T2_MUSIC_STREAMING_SERVICE
      }]
    });
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });

  it(`${T2_INVALID_MALFORMED_PROJECTION}: malformed projection is rejected beside an accepted graph`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph,
      kind_projections: [{ schema_version: 1, kind_values: "spotify" }]
    });

    expectRejectedIndependently(result, graph, "kind_projection_invalid_shape");
  });

  it(`${T2_INVALID_UNBOUND_FACTOR}: unbound factor rejects the projection only`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph,
      kind_projections: [t2KindProposal(graph, "missing-service", [T2_MUSIC_STREAMING_SERVICE])]
    });

    expectRejectedIndependently(result, graph, "kind_projection_invalid_unbound_factor");
  });

  it(`${T2_INVALID_KIND_VALUES_TOO_MANY}: more than two kinds reject the projection only`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph,
      kind_projections: [t2KindProposal(graph, "spotify", [
        T2_MUSIC_STREAMING_SERVICE,
        "podcast service",
        T2_VIDEO_HOSTING
      ])]
    });

    expectRejectedIndependently(
      result,
      graph,
      "kind_projection_invalid_kind_values_too_many"
    );
  });

  it(`${T2_TWO_INSTANCES_SAME_KIND}: shared kind does not merge instance answers`, () => {
    const graph = t2TwoInstanceEvidenceGraph();
    const result = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph,
      kind_projections: [
        t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE]),
        t2KindProposal(graph, "apple-music", [T2_MUSIC_STREAMING_SERVICE])
      ]
    });

    expect(result.status).toBe("formed");
    expect(result.alignments.map((binding) => binding.answer_identity)).toEqual([
      "apple music",
      "spotify"
    ]);
    expect(result.alignments).toHaveLength(2);
    expect(new Set(result.alignments.map((binding) => binding.kind_identity)))
      .toEqual(new Set([T2_MUSIC_STREAMING_SERVICE]));
    expect(result.alignments.map((binding) => binding.factor_id)).toEqual([
      "apple-music",
      "spotify"
    ]);
  });

  it(`${T2_MISSING_KIND_PROJECTION}: missing projection is unavailable, not a graph failure`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const omitted = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph
    });
    const empty = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph,
      kind_projections: []
    });

    expect(omitted.status).toBe("unavailable");
    expect(empty.status).toBe("unavailable");
    expect(omitted.alignments).toEqual([]);
    expect(empty.projections).toEqual([]);
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });

  it(`${T2_POLARITY_VIDEO_HOSTING}: video hosting does not satisfy music streaming`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = materializeKindConstraintAlignment({
      answer_variable_id: "answer",
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      evidence_graph: graph,
      kind_projections: [t2KindProposal(graph, "spotify", [T2_VIDEO_HOSTING])]
    });

    expect(result.operator_id).toBe("kind_constraint_alignment_v1");
    expect(result.status).toBe("ineligible");
    expect(result.alignments).toEqual([]);
    expect(result.projections[0]).toMatchObject({
      status: "formed",
      kind_values: [T2_VIDEO_HOSTING]
    });
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });
});

function expectRejectedIndependently(
  result: ReturnType<typeof materializeKindConstraintAlignment>,
  graph: ReturnType<typeof t2SpotifyEvidenceGraph>,
  reason: string
): void {
  expect(result.operator_id).toBe("kind_constraint_alignment_v1");
  expect(result.status).toBe("rejected");
  expect(result.alignments).toEqual([]);
  expect(result.projections[0]).toMatchObject({
    status: "rejected",
    rejection_reason: reason,
    kind_values: []
  });
  expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
}
