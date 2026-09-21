import { expect, it } from "vitest";
import {
  sourceSemanticInterpretationIdentity, SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticAlignment, admitSourceSemanticQuery, fieldContractSha256,
  SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import { proposeAlignmentSemantics, proposeQuerySemantics } from "@do-soul/alaya-soul";
import {
  FINITE_QUERY, finiteAlignment, finiteQuery, finiteSource, reasonFinite
} from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-finite-fixture.js";

function producerQueryBody(query: ReturnType<typeof finiteQuery>) {
  return {
    variables: query.variables,
    alternatives: query.alternatives,
    return_variables: query.return_variables,
    gaps: query.gaps,
    ...(query.domains === undefined ? {} : { domains: query.domains }),
    ...(query.evaluation === undefined ? {} : { evaluation: query.evaluation })
  };
}

it("admits receiver-produced Q/A and drops dependent answers when membership is removed", () => {
  const baseSource = finiteSource();
  const h = {
    ...baseSource,
    domains: baseSource.domains!.map((row) => ({ ...row, closure: { kind: "open" as const } }))
  };
  const base = finiteQuery();
  const canonical = {
    ...base,
    variables: base.variables.map((row) => row.id === "actor"
      ? { ...row, reference: { kind: "query_text" as const, excerpt: "New" } } : row)
  };
  const receivedQ = proposeQuerySemantics({
    original_query: FINITE_QUERY,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    query_syntax: SOURCE_SEMANTIC_QUERY_CONTRACT
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-query-response-v2",
      outcome: { status: "interpreted" },
      query: producerQueryBody(canonical)
    })
  });
  expect(receivedQ.query?.evaluation).toBeUndefined();
  const admittedQ = admitSourceSemanticQuery(receivedQ.query, FINITE_QUERY);
  expect(admittedQ.kind).toBe("admitted");

  const forged = proposeQuerySemantics({
    original_query: FINITE_QUERY,
    producer_id: "forged.unknown.v1",
    producer_version: "1",
    query_syntax: SOURCE_SEMANTIC_QUERY_CONTRACT
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-query-response-v2",
      outcome: { status: "interpreted" },
      query: producerQueryBody(canonical)
    })
  });
  expect(admitSourceSemanticQuery(forged.query, FINITE_QUERY).kind).toBe("unsupported");

  const hId = sourceSemanticInterpretationIdentity(h, fieldContractSha256);
  const seed = finiteAlignment(h, receivedQ.query!);
  const membership = [{
    query_variable: "actor", source_domain: "users", restrictions: [] as const, status: "member" as const,
    query_support: { kind: "query_text" as const, excerpt: "New" },
    description: "Assume New belongs to users."
  }];
  const receivedA = proposeAlignmentSemantics({
    admitted_q: receivedQ.query!,
    h_descriptors: [{ h_id: hId, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID,
    producer_version: "1",
    alignment_syntax: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-alignment-response-v2",
      outcome: { status: "interpreted", gaps: [] },
      alignment: {
        correspondences: seed.correspondences,
        membership_assumptions: membership
      }
    })
  });
  expect(receivedA.alignment?.membership_assumptions).toEqual(membership);
  expect(admitSourceSemanticAlignment({
    alignment: receivedA.alignment, h, q: receivedQ.query, original_query: FINITE_QUERY
  }).kind).toBe("admitted");

  const assumed = reasonFinite(h, receivedQ.query!, receivedA.alignment!);
  expect(assumed.outcome.status).toBe("interpreted");
  expect(assumed.answers).toHaveLength(1);
  expect(assumed.consumed_leaves.some((row) => row.leaf_kind === "a_membership")).toBe(true);

  const withoutMembership = proposeAlignmentSemantics({
    admitted_q: receivedQ.query!,
    h_descriptors: [{ h_id: hId, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID,
    producer_version: "1",
    alignment_syntax: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-alignment-response-v2",
      outcome: { status: "interpreted", gaps: [] },
      alignment: { correspondences: seed.correspondences }
    })
  });
  expect(reasonFinite(h, receivedQ.query!, withoutMembership.alignment!).answers).toEqual([]);

  const independent = finiteQuery();
  const unrelated = reasonFinite(h, independent, finiteAlignment(h, independent));
  expect(unrelated.outcome.status).toBe("interpreted");
  expect(unrelated.answers?.map((row) => row.returned.actor?.node_id).sort()).toEqual(["rAlice", "rBob"]);
});
