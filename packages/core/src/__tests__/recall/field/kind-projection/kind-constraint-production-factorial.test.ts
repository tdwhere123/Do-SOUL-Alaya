import { describe, expect, it } from "vitest";
import {
  KIND_PROJECTION_DRAFT_PRODUCER_ID,
  OpenSemanticFactorGraphSchema
} from "@do-soul/alaya-protocol";
import { RuleBasedQueryFactFrameExtractor } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import { captureRecallQueryFactFrames } from
  "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import {
  bindProductionKindConstraintAlignment,
  wrapProductionKindProjectionDrafts
} from "../../../../recall/field/kind-projection/production.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import {
  T2_ANSWER_VARIABLE_ID,
  T2_MUSIC_STREAMING_SERVICE,
  T2_QUERY_SOURCE,
  T2_SPOTIFY_SOURCE,
  T2_VIDEO_HOSTING,
  t2KindProposal,
  t2SpotifyResultBindings
} from "./fixtures.js";

const extractor = new RuleBasedQueryFactFrameExtractor();
// T2 "do I use" does not form a G19a type_constraint; graduate-with is the live layout.
const GRAMMAR_FORMED_QUERY = "What music streaming service did I graduate with?";
const GRAMMAR_UNAVAILABLE_QUERY = "When is the meeting?";

describe("G19 grammar × kind-projection production factorial", () => {
  it("grammar+ × kind+ preserves the spotify referent", async () => {
    const { receipt, evidenceGraph } = await alignCell(GRAMMAR_FORMED_QUERY, [
      (graph) => t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE])
    ]);
    expect(receipt.operator_id).toBe("kind_constraint_alignment_v1");
    expect(receipt.authority).toBe("proposed_routing_only");
    expect(receipt.answer_kind_constraint).toBe(T2_MUSIC_STREAMING_SERVICE);
    expect(receipt.status).toBe("formed");
    expect(receipt.alignments).toEqual([expect.objectContaining({
      factor_id: "spotify",
      answer_identity: "spotify",
      kind_identity: T2_MUSIC_STREAMING_SERVICE
    })]);
    expect(OpenSemanticFactorGraphSchema.safeParse(evidenceGraph).success).toBe(true);
  });

  it("grammar+ × kind polarity rejects without erasing the base graph", async () => {
    const { receipt, evidenceGraph } = await alignCell(GRAMMAR_FORMED_QUERY, [
      (graph) => t2KindProposal(graph, "spotify", [T2_VIDEO_HOSTING])
    ]);
    expect(receipt.status).toBe("ineligible");
    expect(receipt.alignments).toEqual([]);
    expect(receipt.projections[0]).toMatchObject({
      status: "formed",
      instance_of: [expect.objectContaining({ kind_identity: T2_VIDEO_HOSTING })]
    });
    expect(OpenSemanticFactorGraphSchema.safeParse(evidenceGraph).success).toBe(true);
  });

  it("grammar- × kind+ stays unavailable and leaves the evidence graph intact", async () => {
    const { receipt, evidenceGraph } = await alignCell(GRAMMAR_UNAVAILABLE_QUERY, [
      (graph) => t2KindProposal(graph, "spotify", [T2_MUSIC_STREAMING_SERVICE])
    ]);
    expect(receipt.status).toBe("unavailable");
    expect(receipt.alignments).toEqual([]);
    expect(receipt.answer_kind_constraint).toBe("");
    expect(OpenSemanticFactorGraphSchema.safeParse(evidenceGraph).success).toBe(true);
  });

  it("grammar- × kind- stays unavailable without a kind payload", async () => {
    const { receipt, evidenceGraph } = await alignCell(GRAMMAR_UNAVAILABLE_QUERY);
    expect(receipt.status).toBe("unavailable");
    expect(receipt.alignments).toEqual([]);
    expect(receipt.projections).toEqual([]);
    expect(OpenSemanticFactorGraphSchema.safeParse(evidenceGraph).success).toBe(true);
  });

  it("wraps a draft only against that evidence graph digest", () => {
    const evidence = evidenceFormation();
    if (evidence.graph === null) throw new Error("evidence OSF fixture failed to form");
    const wrapped = wrapProductionKindProjectionDrafts({
      formationsByEvidenceId: { ev1: evidence },
      draftsByEvidenceId: {
        ev1: [{ factor_id: "spotify", kind_values: [T2_MUSIC_STREAMING_SERVICE] }],
        missing: [{ factor_id: "spotify", kind_values: [T2_MUSIC_STREAMING_SERVICE] }]
      }
    });
    expect(wrapped).toEqual([expect.objectContaining({
      producer_operator_id: KIND_PROJECTION_DRAFT_PRODUCER_ID,
      evidence_graph_digest: digestRecallFieldIdentity(evidence.graph),
      factor_id: "spotify",
      kind_values: [T2_MUSIC_STREAMING_SERVICE]
    })]);
  });

  it("aligns a wrapped draft against its own candidate graph, not the first graph", async () => {
    const factFrameCapture = await captureRecallQueryFactFrames({
      query_text: GRAMMAR_FORMED_QUERY,
      port: extractor
    });
    const query = queryFormation();
    const decoy = decoyEvidenceFormation();
    const evidence = evidenceFormation();
    if (query.status !== "formed" || query.graph === null) {
      throw new Error("query OSF fixture failed to form");
    }
    if (decoy.status !== "formed" || decoy.graph === null) {
      throw new Error("decoy OSF fixture failed to form");
    }
    if (evidence.status !== "formed" || evidence.graph === null) {
      throw new Error("evidence OSF fixture failed to form");
    }
    expect(digestRecallFieldIdentity(decoy.graph)).not.toBe(
      digestRecallFieldIdentity(evidence.graph)
    );
    const wrapped = wrapProductionKindProjectionDrafts({
      formationsByEvidenceId: { decoy, evidence },
      draftsByEvidenceId: {
        evidence: [{ factor_id: "spotify", kind_values: [T2_MUSIC_STREAMING_SERVICE] }]
      }
    });
    const receipt = bindProductionKindConstraintAlignment({
      queryText: GRAMMAR_FORMED_QUERY,
      factFrameCapture,
      queryFormation: query,
      resultVariableIds: query.graph.result_variable_ids,
      resultBindings: t2SpotifyResultBindings(),
      evidenceFormations: { decoy, evidence },
      kindProjections: wrapped
    });
    expect(receipt.authority).toBe("proposed_routing_only");
    expect(receipt.status).toBe("formed");
    expect(receipt.projections[0]).toMatchObject({
      status: "formed",
      factor_id: "spotify",
      evidence_graph_digest: digestRecallFieldIdentity(evidence.graph)
    });
    expect(receipt.alignments).toEqual([expect.objectContaining({
      factor_id: "spotify",
      answer_identity: "spotify",
      kind_identity: T2_MUSIC_STREAMING_SERVICE
    })]);
  });
});

async function alignCell(
  queryText: string,
  kindBuilders?: readonly ((
    graph: NonNullable<ReturnType<typeof evidenceFormation>["graph"]>
  ) => unknown)[]
) {
  const factFrameCapture = await captureRecallQueryFactFrames({
    query_text: queryText,
    port: extractor
  });
  const query = queryFormation();
  const evidence = evidenceFormation();
  if (query.status !== "formed" || query.graph === null) {
    throw new Error("query OSF fixture failed to form");
  }
  if (evidence.status !== "formed" || evidence.graph === null) {
    throw new Error("evidence OSF fixture failed to form");
  }
  const kindProjections = kindBuilders?.map((build) => build(evidence.graph));
  return {
    evidenceGraph: evidence.graph,
    receipt: bindProductionKindConstraintAlignment({
      queryText,
      factFrameCapture,
      queryFormation: query,
      resultVariableIds: query.graph.result_variable_ids,
      resultBindings: t2SpotifyResultBindings(),
      evidenceFormations: { spotify: evidence },
      ...(kindProjections === undefined ? {} : { kindProjections })
    })
  };
}

function queryFormation() {
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: T2_QUERY_SOURCE,
    proposal: {
      schema_version: 1,
      producer_operator_id: "kind-projection-production-fixture-v1",
      source_text: T2_QUERY_SOURCE,
      graph: {
        schema_version: 2,
        source_kind: "query",
        factors: [
          factor("actor", "I", "i"),
          factor("predicate", "use", "use")
        ],
        variables: [{ variable_id: T2_ANSWER_VARIABLE_ID, surface: "What" }],
        result_variable_ids: [T2_ANSWER_VARIABLE_ID],
        propositions: [{
          proposition_id: "use-query",
          predicate_factor_id: "predicate",
          arguments: [
            argument(0, "agent", "factor", "actor"),
            argument(1, "object", "variable", T2_ANSWER_VARIABLE_ID)
          ]
        }]
      }
    }
  });
}

function decoyEvidenceFormation() {
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: "I drink coffee.",
    proposal: {
      schema_version: 1,
      producer_operator_id: "kind-projection-production-fixture-v1",
      source_text: "I drink coffee.",
      graph: {
        schema_version: 2,
        source_kind: "evidence",
        factors: [
          factor("actor", "I", "i"),
          factor("predicate", "drink", "drink"),
          factor("coffee", "coffee", "coffee")
        ],
        variables: [],
        result_variable_ids: [],
        propositions: [{
          proposition_id: "drink-event",
          predicate_factor_id: "predicate",
          arguments: [
            argument(0, "agent", "factor", "actor"),
            argument(1, "object", "factor", "coffee")
          ]
        }]
      }
    }
  });
}

function evidenceFormation() {
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: T2_SPOTIFY_SOURCE,
    proposal: {
      schema_version: 1,
      producer_operator_id: "kind-projection-production-fixture-v1",
      source_text: T2_SPOTIFY_SOURCE,
      graph: {
        schema_version: 2,
        source_kind: "evidence",
        factors: [
          factor("actor", "I", "i"),
          factor("predicate", "use", "use"),
          factor("spotify", "Spotify", "spotify")
        ],
        variables: [],
        result_variable_ids: [],
        propositions: [{
          proposition_id: "use-event",
          predicate_factor_id: "predicate",
          arguments: [
            argument(0, "agent", "factor", "actor"),
            argument(1, "object", "factor", "spotify")
          ]
        }]
      }
    }
  });
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
