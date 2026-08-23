import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KIND_PROJECTION_OPERATOR_ID,
  KindProjectionProposalSchema,
  KindProjectionSchema,
  kindProjectionPreimage,
  verifyKindProjection,
  type KindProjectionBody
} from "../../soul/kind-projection.js";
import {
  OpenSemanticFactorGraphSchema,
  groundOpenSemanticFactorGraph
} from "../../soul/open-semantic-factor-graph.js";
import {
  KIND_PROJECTION_OPERATOR_ID as exportedOperatorId
} from "../../index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("kind projection schema", () => {
  it("exports the independent kind projection from the protocol barrel", () => {
    expect(exportedOperatorId).toBe("kind_projection_v1");
  });

  it("accepts a formed projection and verifies its digest", () => {
    const capture = formedCapture(["music streaming service"]);
    expect(KindProjectionSchema.parse(capture)).toEqual(capture);
    expect(verifyKindProjection(capture, sha256)).toEqual(capture);
    expect(() => verifyKindProjection({
      ...capture,
      factor_id: "other"
    }, sha256)).toThrow(/digest mismatch/u);
  });

  it("rejects more than two kind values on the proposal without touching OSF", () => {
    expect(KindProjectionProposalSchema.safeParse(proposal([
      "music streaming service",
      "podcast service",
      "video hosting"
    ])).success).toBe(false);
  });

  it("rejects category_identities on the strict base OSF graph while the projection still parses", () => {
    const graph = spotifyGraph();
    expect(graph).not.toBeNull();
    expect(OpenSemanticFactorGraphSchema.safeParse({
      ...graph,
      category_identities: ["music streaming service"]
    }).success).toBe(false);
    expect(KindProjectionProposalSchema.safeParse(proposal([
      "music streaming service"
    ])).success).toBe(true);
    expect(OpenSemanticFactorGraphSchema.safeParse(graph).success).toBe(true);
  });

  it("parses a rejection receipt and refuses formed captures that smuggle kinds into a reject", () => {
    const rejected = capture({
      status: "rejected",
      producer_operator_id: null,
      evidence_graph_digest: DIGEST,
      factor_id: null,
      kind_values: [],
      instance_of: [],
      rejection_reason: "kind_projection_invalid_shape"
    });
    expect(KindProjectionSchema.parse(rejected).status).toBe("rejected");
    expect(KindProjectionSchema.safeParse({
      ...rejected,
      kind_values: ["music streaming service"]
    }).success).toBe(false);
    expect(KindProjectionSchema.safeParse({
      ...formedCapture(["music streaming service"]),
      rejection_reason: "kind_projection_invalid_shape"
    }).success).toBe(false);
  });

  it("accepts unavailable and ineligible captures without kind values", () => {
    for (const status of ["unavailable", "ineligible"] as const) {
      expect(KindProjectionSchema.parse(capture({
        status,
        producer_operator_id: null,
        evidence_graph_digest: DIGEST,
        factor_id: "service",
        kind_values: [],
        instance_of: [],
        rejection_reason: null
      })).status).toBe(status);
    }
  });
});

function proposal(kindValues: readonly string[]) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "kind_projection_fixture_v1",
    evidence_graph_digest: DIGEST,
    factor_id: "service",
    kind_values: kindValues
  };
}

function formedCapture(kindValues: readonly string[]) {
  return capture({
    status: "formed",
    producer_operator_id: "kind_projection_fixture_v1",
    evidence_graph_digest: DIGEST,
    factor_id: "service",
    kind_values: kindValues,
    instance_of: kindValues.map((kind_identity) => ({
      predicate: "instance_of" as const,
      kind_identity
    })),
    rejection_reason: null
  });
}

function capture(body: Omit<KindProjectionBody, "schema_version" | "operator_id">) {
  const fullBody: KindProjectionBody = {
    schema_version: 1,
    operator_id: KIND_PROJECTION_OPERATOR_ID,
    ...body
  };
  return {
    ...fullBody,
    projection_digest: `sha256:${sha256(kindProjectionPreimage(fullBody))}`
  };
}

function spotifyGraph() {
  return groundOpenSemanticFactorGraph({
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", "i"),
      factor("predicate", "use", "use"),
      factor("service", "Spotify", "spotify")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "actor"),
        argument(1, "object", "service")
      ]
    }]
  }, "I use Spotify.");
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
