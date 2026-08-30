import { describe, expect, it } from "vitest";
import {
  collapsePropositionStateMeasurement,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import { psiV2CandidatesFromSupport } from
  "../../../../../recall/decision/query-proof/dominance/index.js";
import { materializeSupportFromReceipts } from
  "../../../../../recall/decision/query-proof/support/index.js";
import { QUERY, SNAPSHOT } from "./fixtures.js";

const CAND = "workspace_local:memory_entry:cand-1";
const HYPOTHESIS = `sha256:${"1".repeat(64)}`;

describe("applicable unknown support propositions", () => {
  it("keeps an OSF proposition without polarity as decision-relevant unknown", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        hypothesis_digest: HYPOTHESIS,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at"
          }]
        },
        evidence_ids: ["eu-1"]
      }]
    });

    expect(result.graph.nodes.some((node) =>
      node.kind === "proposition" && node.id === "prop.works-at")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.proposition_observations).toEqual([expect.objectContaining({
      candidate_id: CAND,
      local_proposition_id: "prop.works-at",
      hypothesis_digest: HYPOTHESIS,
      witness: expect.objectContaining({
        epistemic: { kind: "exact" },
        payload: { polarity: "unknown" },
        provenance: [{ source_id: "eu-1", producer: "support.osf.grounds.v1" }]
      })
    })]);

    const [candidate] = psiV2CandidatesFromSupport({
      candidate_keys: [CAND],
      support: result
    });
    expect(candidate?.coordinates).toHaveLength(1);
    expect(candidate?.coordinates[0]?.applicable).toBe(true);
    expect(candidate?.coordinates[0]?.identity).toBeNull();
    expect(candidate?.coordinates[0]?.collapse.status).toBe("blocked");
    const collapse = collapsePropositionStateMeasurement({
      contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
      observations: [result.proposition_observations[0]!.witness]
    });
    expect(collapse.status).toBe("blocked");
    if (collapse.status === "blocked") {
      expect(collapse.reason).toMatch(/unknown/u);
    }
  });

  it("keeps truncated OSF with a query proposition as decision-relevant unknown", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        hypothesis_digest: HYPOTHESIS,
        osf: {
          composition_status: "composed",
          truncated: true,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at"
          }]
        },
        evidence_ids: ["eu-1"]
      }]
    });
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(result.gaps.some((gap) => gap.kind === "osf_truncated")).toBe(true);
    expect(result.proposition_observations).toEqual([expect.objectContaining({
      candidate_id: CAND,
      local_proposition_id: "prop.works-at",
      hypothesis_digest: HYPOTHESIS,
      witness: expect.objectContaining({
        epistemic: { kind: "exact" },
        payload: { polarity: "unknown" },
        provenance: [{ source_id: "eu-1", producer: "support.osf.truncated.v1" }]
      })
    })]);
    const [candidate] = psiV2CandidatesFromSupport({
      candidate_keys: [CAND],
      support: result
    });
    expect(candidate?.coordinates.length).toBeGreaterThan(0);
    expect(candidate?.coordinates.every((coordinate) =>
      coordinate.applicable && coordinate.collapse.status === "blocked")).toBe(true);
  });

  it.each(["unavailable", "ineligible", "rejected", "no_match"] as const)(
    "keeps %s OSF with a query proposition as decision-relevant unknown",
    (status) => {
      const result = materializeSupportFromReceipts({
        query_id: QUERY,
        snapshot_digest: SNAPSHOT,
        candidates: [{
          candidate_key: CAND,
          hypothesis_digest: HYPOTHESIS,
          osf: {
            composition_status: status,
            truncated: false,
            bindings: [{
              variable_id: "x",
              binding_identity: "arg.person",
              semantic_identity: "person.alice",
              evidence_id: "eu-1",
              query_proposition_id: "prop.works-at"
            }]
          },
          evidence_ids: ["eu-1"]
        }]
      });
      expect(result.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
      expect(result.gaps.some((gap) => gap.kind === `osf_${status}`)).toBe(true);
      expect(result.proposition_observations).toEqual([expect.objectContaining({
        candidate_id: CAND,
        local_proposition_id: "prop.works-at",
        hypothesis_digest: HYPOTHESIS,
        witness: expect.objectContaining({
          epistemic: { kind: "exact" },
          payload: { polarity: "unknown" },
          provenance: [{ source_id: "eu-1", producer: `support.osf.${status}.v1` }]
        })
      })]);
      const [candidate] = psiV2CandidatesFromSupport({
        candidate_keys: [CAND],
        support: result
      });
      expect(candidate?.coordinates.length).toBeGreaterThan(0);
      expect(candidate?.coordinates.every((coordinate) =>
        coordinate.applicable && coordinate.collapse.status === "blocked")).toBe(true);
      expect(candidate?.coordinates.some((coordinate) =>
        coordinate.identity !== null)).toBe(false);
    }
  );
});
