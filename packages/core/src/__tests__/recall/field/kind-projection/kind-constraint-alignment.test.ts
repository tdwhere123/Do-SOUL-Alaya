import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OpenSemanticFactorGraphSchema,
  verifyKindProjection
} from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import { materializeKindConstraintAlignment } from
  "../../../../recall/field/kind-projection/alignment.js";
import {
  T2_ANSWER_VARIABLE_ID,
  T2_DUPLICATE_FACTOR_OVERLAYS,
  T2_INVALID_GRAPH_DIGEST,
  T2_INVALID_KIND_VALUES_TOO_MANY,
  T2_INVALID_MALFORMED_PROJECTION,
  T2_INVALID_UNBOUND_FACTOR,
  T2_KIND_PROJECTION_PRODUCER,
  T2_MISSING_KIND_PROJECTION,
  T2_MUSIC_STREAMING_SERVICE,
  T2_POLARITY_VIDEO_HOSTING,
  T2_REJECTED_SIBLING_POLARITY,
  T2_SPOTIFY_MUSIC_STREAMING_HAPPY,
  T2_TWO_INSTANCES_SAME_KIND,
  T2_VIDEO_HOSTING,
  t2KindProposal,
  t2SpotifyEvidenceGraph,
  t2SpotifyQueryGraph,
  t2SpotifyResultBindings,
  t2TwoInstanceEvidenceGraph,
  t2TwoInstanceResultBindings
} from "./fixtures.js";

describe("kind_constraint_alignment_v1", () => {
  it(`${T2_SPOTIFY_MUSIC_STREAMING_HAPPY}: filters the spotify result binding`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const query = t2SpotifyQueryGraph();
    const result = materializeKindConstraintAlignment({
      answer_variable_id: T2_ANSWER_VARIABLE_ID,
      answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
      result_variable_ids: query.result_variable_ids,
      result_bindings: t2SpotifyResultBindings(),
      evidence_graph: graph,
      kind_projections: [
        t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE]),
        t2KindProposal(graph, "actor", [T2_MUSIC_STREAMING_SERVICE])
      ]
    });

    expect(query.result_variable_ids).toEqual([T2_ANSWER_VARIABLE_ID]);
    expect(result.operator_id).toBe("kind_constraint_alignment_v1");
    expect(result.authority).toBe("proposed_routing_only");
    expect(result.status).toBe("formed");
    expect(result.alignments).toEqual([expect.objectContaining({
      variable_id: T2_ANSWER_VARIABLE_ID,
      factor_id: "spotify",
      answer_identity: "spotify",
      kind_identity: T2_MUSIC_STREAMING_SERVICE
    })]);
    expect(result.alignments).toHaveLength(1);
    expect(result.alignments[0]?.answer_identity).not.toBe(T2_MUSIC_STREAMING_SERVICE);
    expect(result.projections[0]).toMatchObject({
      status: "formed",
      operator_id: "kind_projection_v1",
      authority: "proposed_routing_only",
      producer_operator_id: T2_KIND_PROJECTION_PRODUCER,
      factor_id: "spotify",
      evidence_graph_digest: digestRecallFieldIdentity(graph),
      instance_of: [{
        subject_factor_id: "spotify",
        predicate: "instance_of",
        kind_identity: T2_MUSIC_STREAMING_SERVICE
      }]
    });
    expect(verifyKindProjection(result.projections[0], sha256)).toEqual(result.projections[0]);
    expect(result.projections[0]).not.toHaveProperty("kind_values");
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });

  it(`${T2_INVALID_MALFORMED_PROJECTION}: malformed projection is rejected beside an accepted graph`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = align(graph, t2SpotifyResultBindings(), [
      { schema_version: 1 }
    ]);

    expectRejectedIndependently(result, graph, "kind_projection_invalid_shape");
  });

  it(`${T2_INVALID_UNBOUND_FACTOR}: unbound factor rejects the projection only`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = align(graph, t2SpotifyResultBindings(), [
      t2KindProposal(graph, "missing-service", [T2_MUSIC_STREAMING_SERVICE])
    ]);

    expectRejectedIndependently(result, graph, "kind_projection_invalid_unbound_factor");
  });

  it(`${T2_INVALID_GRAPH_DIGEST}: digest mismatch is not an unbound factor`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = align(graph, t2SpotifyResultBindings(), [{
      ...t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE]),
      evidence_graph_digest: `sha256:${"b".repeat(64)}`
    }]);

    expectRejectedIndependently(result, graph, "kind_projection_invalid_graph_digest");
  });

  it(`${T2_INVALID_KIND_VALUES_TOO_MANY}: more than two kinds reject the projection only`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = align(graph, t2SpotifyResultBindings(), [
      t2KindProposal(graph, "spotify", [
        T2_MUSIC_STREAMING_SERVICE,
        "podcast service",
        T2_VIDEO_HOSTING
      ])
    ]);

    expectRejectedIndependently(
      result,
      graph,
      "kind_projection_invalid_kind_values_too_many"
    );
  });

  it(`${T2_TWO_INSTANCES_SAME_KIND}: shared kind does not merge instance bindings`, () => {
    const graph = t2TwoInstanceEvidenceGraph();
    const result = align(graph, t2TwoInstanceResultBindings(), [
      t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE]),
      t2KindProposal(graph, "apple-music", [T2_MUSIC_STREAMING_SERVICE])
    ]);

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
    const omitted = align(graph, t2SpotifyResultBindings());
    const empty = align(graph, t2SpotifyResultBindings(), []);

    expect(omitted.status).toBe("unavailable");
    expect(empty.status).toBe("unavailable");
    expect(omitted.alignments).toEqual([]);
    expect(empty.projections).toEqual([]);
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });

  it(`${T2_POLARITY_VIDEO_HOSTING}: video hosting does not satisfy music streaming`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = align(graph, t2SpotifyResultBindings(), [
      t2KindProposal(graph, "spotify", [T2_VIDEO_HOSTING])
    ]);

    expect(result.operator_id).toBe("kind_constraint_alignment_v1");
    expect(result.status).toBe("ineligible");
    expect(result.alignments).toEqual([]);
    expect(result.projections[0]).toMatchObject({
      status: "formed",
      instance_of: [{
        subject_factor_id: "spotify",
        predicate: "instance_of",
        kind_identity: T2_VIDEO_HOSTING
      }]
    });
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });

  it(`${T2_DUPLICATE_FACTOR_OVERLAYS}: two overlays on one factor reject without minting a second row`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = align(graph, t2SpotifyResultBindings(), [
      t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE, "podcast service"]),
      t2KindProposal(graph, "spotify", [T2_VIDEO_HOSTING, "cloud locker"])
    ]);

    expect(result.status).toBe("rejected");
    expect(result.alignments).toEqual([]);
    expect(result.projections.every((projection) =>
      projection.status === "rejected" &&
      projection.rejection_reason === "kind_projection_invalid_duplicate_factor"
    )).toBe(true);
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });

  it(`${T2_REJECTED_SIBLING_POLARITY}: a rejected sibling does not hide a polarity miss`, () => {
    const graph = t2SpotifyEvidenceGraph();
    const result = align(graph, t2SpotifyResultBindings(), [
      { schema_version: 1 },
      t2KindProposal(graph, "spotify", [T2_VIDEO_HOSTING])
    ]);

    expect(result.status).toBe("ineligible");
    expect(result.alignments).toEqual([]);
    expect(result.projections[0]?.status).toBe("rejected");
    expect(result.projections[1]).toMatchObject({
      status: "formed",
      instance_of: [{ kind_identity: T2_VIDEO_HOSTING }]
    });
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });
});

function align(
  graph: ReturnType<typeof t2SpotifyEvidenceGraph>,
  resultBindings: ReturnType<typeof t2SpotifyResultBindings>,
  kindProjections?: readonly unknown[]
) {
  return materializeKindConstraintAlignment({
    answer_variable_id: T2_ANSWER_VARIABLE_ID,
    answer_kind_constraint: T2_MUSIC_STREAMING_SERVICE,
    result_variable_ids: t2SpotifyQueryGraph().result_variable_ids,
    result_bindings: resultBindings,
    evidence_graph: graph,
    ...(kindProjections === undefined ? {} : { kind_projections: kindProjections })
  });
}

function expectRejectedIndependently(
  result: ReturnType<typeof materializeKindConstraintAlignment>,
  graph: ReturnType<typeof t2SpotifyEvidenceGraph>,
  reason: string
): void {
  expect(result.operator_id).toBe("kind_constraint_alignment_v1");
  expect(result.authority).toBe("proposed_routing_only");
  expect(result.status).toBe("rejected");
  expect(result.alignments).toEqual([]);
  expect(result.projections[0]).toMatchObject({
    status: "rejected",
    rejection_reason: reason,
    instance_of: []
  });
  expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
