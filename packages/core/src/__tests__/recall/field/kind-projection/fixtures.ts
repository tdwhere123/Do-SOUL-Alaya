import {
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";

export const T2_SPOTIFY_SOURCE = "I use Spotify.";
export const T2_TWO_INSTANCE_SOURCE = "I use Spotify and Apple Music.";
export const T2_MUSIC_STREAMING_SERVICE = "music streaming service";
export const T2_VIDEO_HOSTING = "video hosting";
export const T2_KIND_PROJECTION_PRODUCER = "kind_projection_fixture_v1";

export const T2_SPOTIFY_MUSIC_STREAMING_HAPPY = "t2-spotify-music-streaming-happy";
export const T2_INVALID_MALFORMED_PROJECTION = "t2-invalid-malformed-projection";
export const T2_INVALID_UNBOUND_FACTOR = "t2-invalid-unbound-factor";
export const T2_INVALID_KIND_VALUES_TOO_MANY = "t2-invalid-kind-values-too-many";
export const T2_TWO_INSTANCES_SAME_KIND = "t2-two-instances-same-kind";
export const T2_MISSING_KIND_PROJECTION = "t2-missing-kind-projection";
export const T2_POLARITY_VIDEO_HOSTING = "t2-polarity-video-hosting";

export function t2SpotifyEvidenceGraph(): OpenSemanticFactorGraph {
  return groundedGraph(T2_SPOTIFY_SOURCE, [
    factor("actor", "I", "i"),
    factor("predicate", "use", "use"),
    factor("spotify", "Spotify", "spotify")
  ], [
    argument(0, "agent", "actor"),
    argument(1, "object", "spotify")
  ]);
}

export function t2TwoInstanceEvidenceGraph(): OpenSemanticFactorGraph {
  return groundedGraph(T2_TWO_INSTANCE_SOURCE, [
    factor("actor", "I", "i"),
    factor("predicate", "use", "use"),
    factor("spotify", "Spotify", "spotify"),
    factor("apple-music", "Apple Music", "apple music")
  ], [
    argument(0, "agent", "actor"),
    argument(1, "object", "spotify"),
    argument(2, "object", "apple-music")
  ]);
}

export function t2KindProposal(
  graph: OpenSemanticFactorGraph,
  factorId: string,
  kindValues: readonly string[]
) {
  return {
    schema_version: 1 as const,
    producer_operator_id: T2_KIND_PROJECTION_PRODUCER,
    evidence_graph_digest: digestRecallFieldIdentity(graph),
    factor_id: factorId,
    kind_values: kindValues
  };
}

function groundedGraph(
  sourceText: string,
  factors: ReturnType<typeof factor>[],
  argumentsValue: ReturnType<typeof argument>[]
): OpenSemanticFactorGraph {
  const graph = groundOpenSemanticFactorGraph({
    schema_version: 2,
    source_kind: "evidence",
    factors,
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
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

function argument(position: number, bindingIdentity: string, referenceId: string) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: "factor" as const,
    reference_id: referenceId
  };
}
