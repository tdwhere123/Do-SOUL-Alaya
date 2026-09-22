import { authoredQuerySemantics, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { expect, it } from "vitest";
import {
  sourceSemanticInterpretationIdentity, SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticCorrespondence, admitSourceSemanticQuery, fieldContractSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import { proposeCorrespondenceSemantics, proposeQuerySemantics } from "@do-soul/alaya-soul";
import {
  FINITE_QUERY, finiteCorrespondence, finiteQuery, finiteSource, reasonFinite
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

it("admits authored query semantics and received semantic correspondence and drops dependent answers when membership is removed", () => {
  const baseSource = finiteSource();
  const sourceInterpretation = {
    ...baseSource,
    domains: baseSource.domains!.map((row) => ({ ...row, closure: { kind: "open" as const } }))
  };
  const base = finiteQuery();
  const canonical = {
    ...base,
    variables: base.variables.map((row) => row.id === "actor"
      ? { ...row, reference: { kind: "query_text" as const, excerpt: "New" } } : row)
  };
  const receivedQuerySemantics = authoredQuerySemantics({ original_query: FINITE_QUERY, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, producerQueryBody(canonical));
  expect(receivedQuerySemantics.query?.evaluation).toBeUndefined();
  const admittedQuerySemantics = admitSourceSemanticQuery(receivedQuerySemantics.query, FINITE_QUERY);
  expect(admittedQuerySemantics.kind).toBe("admitted");

  const forged = authoredQuerySemantics({ original_query: FINITE_QUERY, producer_id: "forged.unknown.v1", producer_version: "1" }, producerQueryBody(canonical));
  expect(admitSourceSemanticQuery(forged.query, FINITE_QUERY).kind).toBe("unsupported");

  const sourceInterpretationId = sourceSemanticInterpretationIdentity(sourceInterpretation, fieldContractSha256);
  const seed = finiteCorrespondence(sourceInterpretation, receivedQuerySemantics.query!);
  const membership = [{
    query_variable: "actor", source_domain: "users", restrictions: [] as const, status: "member" as const,
    query_support: { kind: "query_text" as const, excerpt: "New" },
    description: "Assume New belongs to users."
  }];
  const receivedCorrespondence = receiveAuthoredCorrespondence({ original_query: FINITE_QUERY, admitted_query_semantics: receivedQuerySemantics.query!, source_interpretation_descriptors: [{ source_interpretation_id: sourceInterpretationId, interpretation: sourceInterpretation }], producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, {
        correspondences: seed.correspondences,
        membership_assumptions: membership
      }, { status: "interpreted", gaps: [] });
  expect(receivedCorrespondence.semantic_correspondence?.membership_assumptions).toEqual(membership);
  expect(admitSourceSemanticCorrespondence({
    semantic_correspondence: receivedCorrespondence.semantic_correspondence, source_interpretation: sourceInterpretation, query_semantics: receivedQuerySemantics.query, original_query: FINITE_QUERY
  }).kind).toBe("admitted");

  const assumed = reasonFinite(sourceInterpretation, receivedQuerySemantics.query!, receivedCorrespondence.semantic_correspondence!);
  expect(assumed.outcome.status).toBe("interpreted");
  expect(assumed.binding_results).toHaveLength(1);
  expect(assumed.consumed_leaves.some((row) => row.leaf_kind === "semantic_correspondence_membership")).toBe(true);

  const withoutMembership = receiveAuthoredCorrespondence({ original_query: FINITE_QUERY, admitted_query_semantics: receivedQuerySemantics.query!, source_interpretation_descriptors: [{ source_interpretation_id: sourceInterpretationId, interpretation: sourceInterpretation }], producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences: seed.correspondences }, { status: "interpreted", gaps: [] });
  expect(reasonFinite(sourceInterpretation, receivedQuerySemantics.query!, withoutMembership.semantic_correspondence!).binding_results).toEqual([]);

  const independent = finiteQuery();
  const unrelated = reasonFinite(sourceInterpretation, independent, finiteCorrespondence(sourceInterpretation, independent));
  expect(unrelated.outcome.status).toBe("interpreted");
  expect(unrelated.binding_results?.map((row) => row.returned.actor?.node_id).sort()).toEqual(["rAlice", "rBob"]);
}, 15_000);
