import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";

export const CAPTURE_PROOF_CANDIDATE_KEY = "workspace_local:memory_entry:memory-1";
export const CAPTURE_PROOF_UNIVERSE = {
  status: "unavailable" as const,
  reason: "candidate_universe_not_proved" as const
};
export const CAPTURE_PROOF_IDENTITY = {
  request_digest: { status: "unavailable" as const, reason: "request_not_sealed" as const },
  workspace_id: { status: "unavailable" as const, reason: "workspace_not_sealed" as const },
  snapshot_digest: { status: "unavailable" as const, reason: "snapshot_not_sealed" as const }
};

export function sealLexicalProof<T extends Record<string, unknown>>(body: T) {
  return { ...body, proof_digest: digestRecallFieldIdentity(body) };
}

export function capturedTruncatedProof() {
  const rows = [
    {
      candidate_key: "p1",
      raw_group_key: -9,
      lane_index: 0,
      grouped_ordinal: 1,
      observation_state: "observed" as const
    },
    {
      candidate_key: "p2",
      raw_group_key: -4,
      lane_index: 1,
      grouped_ordinal: 0,
      observation_state: "observed" as const
    }
  ];
  return sealLexicalProof({
    schema_version: 1 as const,
    proof_id: "alaya.recall.lexical-bound-proof.v1" as const,
    status: "captured" as const,
    receipt: {
      schema_version: 1 as const,
      receipt_id: "alaya.recall.x0.lexical-raw-rank.v1" as const,
      producer_id: "alaya.storage.mergeKeywordSearchRows.v1" as const,
      query_run_id: "memory.keyword.lexical_relaxed.depth:1",
      merge_limit: 1,
      lanes: [{
        lane_id: "porter" as const,
        raw_key_kind: "bm25_raw_rank" as const,
        source_priority: 1 as const,
        applicability_source: "memory_fts_lane" as const,
        list_n: 2,
        requested_limit: 1,
        status: "truncated" as const,
        rows,
        unseen_upper_bound: 0
      }],
      candidates: [{
        candidate_key: "p1",
        lane_hits: [{
          lane_id: "porter" as const,
          raw_group_key: -9,
          grouped_ordinal: 1,
          lane_index: 0
        }],
        admitted: true,
        chosen_lane_id: "porter" as const,
        chosen_normalized_rank: 1,
        post_merge_index: 0,
        discarded_lane_ids: []
      }],
      post_merge: [{ candidate_key: "p1", normalized_rank: 1 }]
    },
    observed_candidate_keys: ["p1", "p2"],
    evaluated_universe: CAPTURE_PROOF_UNIVERSE,
    field_prefix: "lexical_relaxed" as const,
    candidate_key_domain: "memory_object_id" as const,
    identity: CAPTURE_PROOF_IDENTITY
  });
}

export function absentProof() {
  return sealLexicalProof({
    schema_version: 1 as const,
    proof_id: "alaya.recall.lexical-bound-proof.v1" as const,
    status: "proof_absent" as const,
    reason: "unavailable" as const,
    receipt: null,
    observed_candidate_keys: {
      status: "unavailable" as const,
      reason: "proof_absent" as const
    },
    evaluated_universe: CAPTURE_PROOF_UNIVERSE,
    field_prefix: { status: "unavailable" as const, reason: "field_prefix_not_sealed" as const },
    candidate_key_domain: {
      status: "unavailable" as const,
      reason: "candidate_key_domain_not_sealed" as const
    },
    identity: CAPTURE_PROOF_IDENTITY
  });
}

export function withNonMonotoneFrontier(proof: ReturnType<typeof capturedTruncatedProof>) {
  const lane = proof.receipt.lanes[0]!;
  const { proof_digest: _digest, ...body } = {
    ...proof,
    receipt: {
      ...proof.receipt,
      lanes: [{
        ...lane,
        rows: [lane.rows[1]!, lane.rows[0]!],
        unseen_upper_bound: {
          status: "unavailable" as const,
          reason: "producer_order_not_monotone" as const
        }
      }]
    }
  };
  return sealLexicalProof(body);
}

export function provenanceMap() {
  const binding = {
    variable_id: "v-city",
    binding_identity: "osf-binding:alice-lives-paris",
    semantic_identity: "city:paris",
    evidence_id: "ev-gold",
    query_proposition_id: "q-alice-lives",
    evidence_proposition_id: "e-alice-lives"
  };
  return {
    [CAPTURE_PROOF_CANDIDATE_KEY]: {
      ...unavailableOsfRow(CAPTURE_PROOF_CANDIDATE_KEY, {
        reason: "osf_binding_not_attributed",
        formation_status: "formed",
        composition_status: "composed"
      }),
      osf: {
        status: "certified" as const,
        reason: null,
        formation_status: "formed" as const,
        completeness_present: true,
        composition_status: "composed" as const,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        bindings: { status: "available" as const, value: [binding] }
      },
      evidence_links: { status: "available" as const, value: ["ev-gold"] }
    },
    "cand-ineligible": unavailableOsfRow("cand-ineligible", {
      reason: "osf_composition_not_composed",
      formation_status: "formed",
      composition_status: "ineligible"
    }),
    "cand-rejected": unavailableOsfRow("cand-rejected", {
      reason: "osf_composition_not_composed",
      formation_status: "formed",
      composition_status: "rejected"
    }),
    "cand-truncated": unavailableOsfRow("cand-truncated", {
      reason: "osf_composition_truncated",
      formation_status: "formed",
      composition_status: "composed"
    })
  };
}

export function unavailableOsfRow(
  candidateKey: string,
  osf: {
    readonly reason: "certified_osf_receipt_absent" | "osf_composition_not_composed"
      | "osf_composition_truncated" | "osf_binding_not_attributed";
    readonly formation_status: "formed" | "unavailable";
    readonly composition_status: "composed" | "ineligible" | "rejected" | "unavailable" | "truncated";
  }
) {
  const gap = (reason: typeof osf.reason | "typed_fact_frame_receipt_absent" | "evidence_link_absent"
    | "polarity_receipt_absent" | "relation_validity_receipt_absent"
    | "supersession_receipt_absent" | "contradiction_receipt_absent") => ({
    status: "unavailable" as const,
    reason
  });
  return {
    schema_version: 1 as const,
    operator_id: "candidate_proposition_provenance_v1" as const,
    candidate_key: candidateKey,
    osf: {
      status: "unavailable" as const,
      reason: osf.reason,
      formation_status: osf.formation_status,
      completeness_present: osf.formation_status === "formed",
      composition_status: osf.composition_status,
      producer_operator_id: osf.formation_status === "formed"
        ? QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
        : null,
      bindings: gap(osf.reason)
    },
    typed_fact_frames: gap("typed_fact_frame_receipt_absent"),
    evidence_links: gap("evidence_link_absent"),
    polarity: gap("polarity_receipt_absent"),
    relation_validity: gap("relation_validity_receipt_absent"),
    supersession: gap("supersession_receipt_absent"),
    contradiction: gap("contradiction_receipt_absent")
  };
}
