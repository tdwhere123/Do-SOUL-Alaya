import { QueryInterpretationProposalSchema, type ClaimDemand, type ProposedGuard,
  type ProposedQueryProgram } from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query-identity.js";
import { QUERY_PROPOSAL_CORE_PRODUCER_ID } from "../../../../recall/conditional-field/query/query-proposal-producer-registry.js";
import { YESTERDAY_END, YESTERDAY_START } from "./deployment.fixture.js";

export const deploymentClaimDemands: readonly ClaimDemand[] = [{ variable: "h", proposition_kind: "common_cause",
  argument_variables: ["r", "h"], required_claim: "any" }];

/** An authored proposal for the planted deployment graph, not a language classifier. */
export function deploymentProposal(query: string,
  interval = { start: YESTERDAY_START, end: YESTERDAY_END }) {
  const anchor: ProposedGuard = { schema_version: 1, kind: "interval_relation", variable: "r", time_scope: "anchor",
    interval: { ...interval, time_domain: "calendar_day" },
    predicate_name: 'source.filters:{"event_kind":"failed_deployment"}' };
  const item = (variable: string): ProposedGuard => ({ schema_version: 1, kind: "query_predicate", variable, time_scope: "none" });
  const relation = (kind: string, source: string, target: string, guard: ProposedGuard): ProposedQueryProgram => ({
    schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    guard, facet_mode: "same_path", threshold_milligrades: 0
  });
  return QueryInterpretationProposalSchema.parse({ schema_version: 1, producer_id: QUERY_PROPOSAL_CORE_PRODUCER_ID,
    original_query_digest: digestOriginalQuery(query),
    program: { schema_version: 1, kind: "alternative", options: [
      { schema_version: 1, kind: "epsilon" }, relation("config_direct", "r", "c", anchor),
      { schema_version: 1, kind: "sequence", steps: [relation("observed_log", "r", "l", anchor),
        relation("config_via_log", "l", "c", item("c"))] },
      { schema_version: 1, kind: "sequence", steps: [relation("uses_service", "r", "s", anchor),
        relation("associated_history", "s", "h", item("h"))] }
    ] }
  });
}
