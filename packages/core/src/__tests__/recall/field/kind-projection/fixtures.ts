import {
  KIND_PROJECTION_SCHEMA_VERSION,
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import type { KindConstraintResultBinding } from
  "../../../../recall/field/kind-projection/alignment.js";

export const T2_SPOTIFY_SOURCE = "I use Spotify.";
export const T2_TWO_INSTANCE_SOURCE = "I use Spotify and Apple Music.";
export const T2_QUERY_SOURCE = "What music streaming service do I use?";
export const T2_MUSIC_STREAMING_SERVICE = "music streaming service";
export const T2_VIDEO_HOSTING = "video hosting";
export const T2_KIND_PROJECTION_PRODUCER = "kind_projection_fixture_v1";
export const T2_ANSWER_VARIABLE_ID = "answer";

export const T2_SPOTIFY_MUSIC_STREAMING_HAPPY = "t2-spotify-music-streaming-happy";
export const T2_INVALID_MALFORMED_PROJECTION = "t2-invalid-malformed-projection";
export const T2_INVALID_UNBOUND_FACTOR = "t2-invalid-unbound-factor";
export const T2_INVALID_GRAPH_DIGEST = "t2-invalid-graph-digest";
export const T2_INVALID_KIND_VALUES_TOO_MANY = "t2-invalid-kind-values-too-many";
export const T2_TWO_INSTANCES_SAME_KIND = "t2-two-instances-same-kind";
export const T2_MISSING_KIND_PROJECTION = "t2-missing-kind-projection";
export const T2_POLARITY_VIDEO_HOSTING = "t2-polarity-video-hosting";
export const T2_REJECTED_SIBLING_POLARITY = "t2-rejected-sibling-polarity";
export const T2_DUPLICATE_FACTOR_OVERLAYS = "t2-duplicate-factor-overlays";
export const T2_LYING_BINDING_IDENTITY = "t2-lying-binding-identity";

export function t2SpotifyEvidenceGraph(): OpenSemanticFactorGraph {
  return groundedGraph("evidence", T2_SPOTIFY_SOURCE, [
    factor("actor", "I", "i"),
    factor("predicate", "use", "use"),
    factor("spotify", "Spotify", "spotify")
  ], [], [
    argument(0, "agent", "factor", "actor"),
    argument(1, "object", "factor", "spotify")
  ]);
}

export function t2TwoInstanceEvidenceGraph(): OpenSemanticFactorGraph {
  return groundedGraph("evidence", T2_TWO_INSTANCE_SOURCE, [
    factor("actor", "I", "i"),
    factor("predicate", "use", "use"),
    factor("spotify", "Spotify", "spotify"),
    factor("apple-music", "Apple Music", "apple music")
  ], [], [
    argument(0, "agent", "factor", "actor"),
    argument(1, "object", "factor", "spotify"),
    argument(2, "object", "factor", "apple-music")
  ]);
}

export function t2SpotifyQueryGraph(): OpenSemanticFactorGraph {
  return groundedGraph("query", T2_QUERY_SOURCE, [
    factor("actor", "I", "i"),
    factor("predicate", "use", "use")
  ], [{ variable_id: T2_ANSWER_VARIABLE_ID, surface: "What" }], [
    argument(0, "agent", "factor", "actor"),
    argument(1, "object", "variable", T2_ANSWER_VARIABLE_ID)
  ]);
}

export function t2SpotifyResultBindings(): readonly KindConstraintResultBinding[] {
  return [resultBinding("spotify")];
}

export function t2TwoInstanceResultBindings(): readonly KindConstraintResultBinding[] {
  return [
    resultBinding("spotify"),
    resultBinding("apple-music")
  ];
}

export function t2KindProposal(
  graph: OpenSemanticFactorGraph,
  factorId: string,
  kindValues: readonly string[]
) {
  return {
    schema_version: KIND_PROJECTION_SCHEMA_VERSION,
    producer_operator_id: T2_KIND_PROJECTION_PRODUCER,
    evidence_graph_digest: digestRecallFieldIdentity(graph),
    factor_id: factorId,
    kind_values: kindValues
  };
}

function resultBinding(evidenceFactorId: string): KindConstraintResultBinding {
  return {
    variable_id: T2_ANSWER_VARIABLE_ID,
    evidence_factor_id: evidenceFactorId
  };
}

function groundedGraph(
  sourceKind: "evidence" | "query",
  sourceText: string,
  factors: ReturnType<typeof factor>[],
  variables: readonly Readonly<{ readonly variable_id: string; readonly surface: string }>[],
  argumentsValue: ReturnType<typeof argument>[]
): OpenSemanticFactorGraph {
  const graph = groundOpenSemanticFactorGraph({
    schema_version: 2,
    source_kind: sourceKind,
    factors,
    variables,
    result_variable_ids: variables.map((variable) => variable.variable_id),
    propositions: [{
      proposition_id: sourceKind === "query" ? "use-query" : "use-event",
      predicate_factor_id: "predicate",
      arguments: argumentsValue
    }]
  }, sourceText);
  if (graph === null) {
    throw new Error(`t2 fixture failed to ground ${sourceText}`);
  }
  return graph;
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
