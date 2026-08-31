import { describe, expect, it } from "vitest";
import {
  materializeSupportFromReceipts,
  type SupportRelationalSubjectV1
} from
  "../../../../../recall/decision/query-proof/support/index.js";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";
import { QUERY, SNAPSHOT } from "./fixtures.js";
import {
  RELATIONAL_SNAPSHOT,
  authorityContext,
  createAuthorityContext,
  createRelationalReceipt,
  materializePath,
  pathReceipt,
  pathMaterialization,
  pathSubject,
  polarityCandidate,
  polarityReceipt,
  resealRelationalReceipt,
  supersessionReceipt
} from "./relational-authority-fixtures.js";

const CAND = "workspace_local:memory_entry:cand-1";
const CAND_B = "workspace_local:memory_entry:cand-2";

describe("support receipt adapters", () => {
  it("materializes OSF bindings, fact frames, polarity, and evidence lineage", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [{
        candidate_key: CAND,
        hypothesis_digest: `sha256:${"1".repeat(64)}`,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at",
            source_lineage_id: "lineage-a"
          }]
        },
        fact_frames: [{ semantic_identity: "person.alice", role: "entity", evidence_id: "eu-1" }],
        polarity: {
          status: "available",
          value: {
            polarity: "positive",
            lineage_id: "lineage-a",
            proposition_id: "prop.works-at",
            receipt: polarityReceipt("lineage-a")
          }
        },
        evidence_ids: ["eu-1"],
        f3_present: true
      }]
    });
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding" && node.id === "person.alice")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "supports")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "sourced_from")).toBe(true);
    expect(result.polarities[0]?.payload?.polarity).toBe("supported_only");
    expect(result.proposition_observations[0]).toMatchObject({
      candidate_id: CAND,
      local_proposition_id: "prop.works-at",
      hypothesis_digest: `sha256:${"1".repeat(64)}`,
      witness: {
        identity: { candidate_id: CAND, proposition_id: "prop.works-at" },
        payload: { polarity: "supported_only" }
      }
    });
  });

  it("does not substitute a binding role for an absent semantic identity", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "agent",
            semantic_identity: "",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at"
          }]
        }
      }]
    });
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(false);
    expect(result.gaps.some((gap) => gap.kind === "binding_absent")).toBe(true);
  });

  it.each([
    ["variable_id", " \t"],
    ["binding_identity", "\n"],
    ["semantic_identity", " \t\n"],
    ["evidence_id", "  "],
    ["query_proposition_id", "\r\n"],
    ["source_lineage_id", " \t"]
  ] as const)("fails closed for a whitespace-only OSF %s", (field, value) => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at",
            source_lineage_id: "lineage-a",
            [field]: value
          }]
        }
      }]
    });

    expect(result.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "expresses")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "sourced_from")).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({
      kind: "binding_absent",
      owner: CAND,
      detail: "OSF binding contains a blank identity"
    }));
  });

  it("preserves exact valid OSF identity bytes", () => {
    const semanticIdentity = " person.alice ";
    const propositionId = " prop.works-at ";
    const evidenceId = " eu-1 ";
    const lineageId = " lineage-a ";
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: " x ",
            binding_identity: " arg.person ",
            semantic_identity: semanticIdentity,
            evidence_id: evidenceId,
            query_proposition_id: propositionId,
            source_lineage_id: lineageId
          }]
        }
      }]
    });

    expect(result.graph.nodes).toEqual(expect.arrayContaining([
      { kind: "answer_binding", id: semanticIdentity },
      { kind: "proposition", id: propositionId },
      { kind: "evidence_unit", id: evidenceId },
      { kind: "source_lineage", id: lineageId }
    ]));
    expect(result.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "expresses",
        to: { kind: "answer_binding", id: semanticIdentity }
      }),
      expect.objectContaining({
        kind: "yields",
        from: { kind: "answer_binding", id: semanticIdentity },
        to: { kind: "proposition", id: propositionId }
      })
    ]));
    expect(result.gaps).toEqual([]);
  });

  it("does not mint a proposition from a binding lemma when query_proposition_id is absent", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1"
          }]
        }
      }]
    });
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding" && node.id === "person.alice")).toBe(true);
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.graph.nodes.some((node) => node.id === "person.alice" && node.kind === "proposition")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(false);
    expect(result.gaps.some((gap) => gap.kind === "binding_absent")).toBe(true);
  });

  it("does not vote supports or supported_only from OSF formation alone", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at",
            source_lineage_id: "lineage-a"
          }]
        }
      }]
    });
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "supports")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "refutes")).toBe(false);
    expect(result.polarities).toEqual([]);
  });

  it("records ineligible and rejected OSF as gaps, not empty bindings", () => {
    const ineligible = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "ineligible",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-trap",
            query_proposition_id: "prop.trap"
          }]
        }
      }]
    });
    expect(ineligible.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(ineligible.graph.nodes.some((node) =>
      node.kind === "proposition" && node.id === "prop.trap")).toBe(true);
    expect(ineligible.proposition_observations).toEqual([expect.objectContaining({
      local_proposition_id: "prop.trap",
      witness: expect.objectContaining({ payload: { polarity: "unknown" } })
    })]);
    expect(ineligible.gaps.some((gap) => gap.kind === "osf_ineligible")).toBe(true);

    const rejected = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: { composition_status: "rejected", truncated: false, bindings: [] }
      }]
    });
    expect(rejected.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(rejected.gaps.some((gap) => gap.kind === "osf_rejected")).toBe(true);
  });

  it("emits supersedes from a bound proposition pair and leaves bare standing open", () => {
    const paired = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [{
        candidate_key: CAND,
        supersession: {
          status: "available",
          value: {
            standing: "superseded",
            lineage_id: "lineage-old",
            proposition_id: "prop.old",
            counterpart_proposition_id: "prop.new",
            receipt: supersessionReceipt("lineage-old", "prop.old", "prop.new")
          }
        }
      }]
    });
    expect(paired.graph.edges.some((edge) =>
      edge.kind === "supersedes"
      && edge.from.id === "prop.new"
      && edge.to.id === "prop.old"
    )).toBe(true);
    expect(paired.gaps.some((gap) => gap.kind === "supersedes_open")).toBe(false);

    const open = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        supersession: {
          status: "available",
          value: {
            standing: "superseded",
            lineage_id: "lineage-old",
            proposition_id: "prop.old"
          }
        }
      }]
    });
    expect(open.graph.edges.some((edge) => edge.kind === "supersedes")).toBe(false);
    expect(open.graph.nodes.filter((node) => node.kind === "proposition").map((node) => node.id))
      .toEqual([]);
    expect(open.gaps.some((gap) => gap.kind === "authority_untrusted")).toBe(true);
  });

  it("keeps bare standing conflicted and resolves only with a fully bound receipt", () => {
    const both = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive", polarityReceipt("lineage-a")),
        polarityCandidate(CAND_B, "lineage-b", "negative", polarityReceipt("lineage-b"))
      ]
    });
    expect(both.polarities[0]?.payload?.polarity).toBe("both");
    expect(both.polarities[0]?.epistemic.kind).toBe("conflict");

    const resolved = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive", polarityReceipt("lineage-a")),
        {
          ...polarityCandidate(CAND_B, "lineage-b", "negative", polarityReceipt("lineage-b")),
          supersession: {
            status: "available",
            value: {
              standing: "superseded",
              lineage_id: "lineage-b",
              proposition_id: "prop.works-at",
              receipt: supersessionReceipt("lineage-b", "prop.works-at")
            }
          }
        }
      ]
    });
    expect(resolved.polarities[0]?.payload?.polarity).toBe("supported_only");

    const bareStanding = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive", polarityReceipt("lineage-a")),
        {
          ...polarityCandidate(CAND_B, "lineage-b", "negative", polarityReceipt("lineage-b")),
          supersession: {
            status: "available",
            value: {
              standing: "superseded",
              lineage_id: "lineage-b",
              proposition_id: "prop.works-at"
            }
          }
        }
      ]
    });
    expect(bareStanding.polarities[0]?.payload?.polarity).toBe("both");
    expect(bareStanding.gaps.some((gap) => gap.kind === "authority_untrusted")).toBe(true);
  });

  it.each([
    ["timeless", { kind: "timeless" as const }],
    ["inactive", {
      kind: "bounded" as const,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-29T00:00:00.000Z"
    }]
  ])("does not admit proposition or grounds from a tampered %s-time path", (_label, valid_time_domain) => {
    const result = pathMaterialization({}, pathReceipt({ valid_time_domain }));
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(false);
    expect(result.gaps.some((gap) => gap.kind === "relational_identity_mismatch")).toBe(true);
    expect(result.outcomes.some((outcome) => outcome.status === "malformed")).toBe(true);
  });

  it.each([
    ["query", pathReceipt({ query_id: "wrong-query" })],
    ["snapshot", pathReceipt({ snapshot_digest: `sha256:${"d".repeat(64)}` })],
    ["transaction", pathReceipt({ transaction_frontier: "tx-frontier-wrong" })],
    ["authority", pathReceipt({ authorized_scope: "recall.untrusted" })],
    ["source", pathReceipt({ source_owner: "forged_source" })],
    ["producer", pathReceipt({ producer_operator_id: "forged_producer" })],
    ["version", pathReceipt({ producer_operator_version: "forged_version" })],
    ["generation", pathReceipt({ generation: "forged_generation" })],
    ["digest", pathReceipt({ receipt_digest: `sha256:${"f".repeat(64)}` })]
  ])("does not let wrong %s binding admit relational truth", (_label, receipt) => {
    const result = pathMaterialization({}, receipt);
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(false);
    expect(result.gaps.some((gap) =>
      gap.kind === "relational_identity_mismatch"
      || gap.kind === "transaction_unfrozen"
      || gap.kind === "authority_untrusted"
    )).toBe(true);
  });

  it("keeps absent, producer-unavailable, malformed, and observed outcomes distinct", () => {
    const absent = materializePath(authorityContext(), undefined);
    expect(absent.outcomes).toContainEqual({
      status: "not_observed",
      owner: CAND,
      source_owner: "path_projection",
      reason: "receipt_absent"
    });

    const unavailableContext = createAuthorityContext({ sourceView: "unavailable" });
    const unavailableReceipt = createRelationalReceipt(
      unavailableContext,
      pathSubject(),
      {}
    );
    const unavailable = materializePath(unavailableContext, unavailableReceipt);
    expect(unavailable.outcomes).toContainEqual({
      status: "producer_unavailable",
      owner: CAND,
      source_owner: "path_relations",
      reason: "source_view_unavailable"
    });

    const malformed = pathMaterialization({}, pathReceipt({
      receipt_digest: `sha256:${"f".repeat(64)}`
    }));
    expect(malformed.outcomes[0]).toMatchObject({
      status: "malformed",
      contract_code: "receipt_digest_mismatch"
    });
    expect(pathMaterialization({}).outcomes[0]).toMatchObject({ status: "observed" });
  });

  it("keeps a shaped relational receipt unavailable without its source verifier", () => {
    const context = createAuthorityContext({ includeVerifiers: false });
    const receipt = createRelationalReceipt(context, pathSubject(), {});
    expect(materializePath(context, receipt).outcomes[0]).toMatchObject({
      status: "producer_unavailable",
      source_owner: "path_relations",
      reason: "source_verifier_unavailable"
    });
  });

  it("rejects caller-owned observations and path-owned polarity even with consistent digests", () => {
    const context = authorityContext();
    const validPath = createRelationalReceipt(context, pathSubject(), {});
    const callerObservationBody = {
      ...validPath.source_observation,
      source_observation_id: "caller-owned-observation"
    };
    const { observation_digest: _oldDigest, ...unsignedObservation } = callerObservationBody;
    const callerObservation = {
      ...unsignedObservation,
      observation_digest: digestRecallFieldIdentity(unsignedObservation)
    };
    const callerReceipt = resealRelationalReceipt({
      ...validPath,
      source_observation: callerObservation,
      source_receipt_digest: digestRecallFieldIdentity(callerObservation)
    });
    expect(materializePath(context, callerReceipt).outcomes[0]).toMatchObject({
      status: "malformed",
      contract_code: "source_observation_mismatch"
    });

    const polaritySubject: SupportRelationalSubjectV1 = {
      kind: "polarity",
      proposition_id: "prop.works-at",
      lineage_id: "lineage-forged"
    };
    const pathOwnedPolarity = createRelationalReceipt(context, polaritySubject, {
      test_source_owner: "path_relations"
    });
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: context.snapshot_vector.vector_digest,
      authority_context: context,
      candidates: [polarityCandidate(CAND, "lineage-forged", "positive", pathOwnedPolarity)]
    });
    expect(result.outcomes[0]).toMatchObject({
      status: "malformed",
      contract_code: "source_observation_mismatch"
    });
  });

  it("accepts timeless only from a timeless source declaration", () => {
    const timelessContext = createAuthorityContext({ validTime: { kind: "timeless" } });
    const timelessReceipt = createRelationalReceipt(timelessContext, pathSubject(), {});
    expect(materializePath(timelessContext, timelessReceipt).outcomes[0])
      .toMatchObject({ status: "observed" });

    const forgedBounded = {
      ...timelessReceipt,
      valid_time_domain: {
        kind: "open" as const,
        from: "2026-08-01T00:00:00.000Z"
      }
    };
    expect(materializePath(timelessContext, forgedBounded).outcomes[0])
      .toMatchObject({ status: "malformed" });
  });

  it("treats truncated or unavailable OSF as unknown, not an empty binding set", () => {
    const truncated = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: true,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-trap"
          }]
        }
      }]
    });
    expect(truncated.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(truncated.gaps.some((gap) => gap.kind === "osf_truncated")).toBe(true);

    const unavailable = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: { composition_status: "unavailable", truncated: false, bindings: [] }
      }]
    });
    expect(unavailable.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(unavailable.gaps.some((gap) => gap.kind === "osf_unavailable")).toBe(true);

    const noMatch = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: { composition_status: "no_match", truncated: false, bindings: [] }
      }]
    });
    expect(noMatch.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(noMatch.gaps.some((gap) => gap.kind === "osf_no_match")).toBe(true);
  });

  it("keeps F0-F2 evidence when F3 is absent and does not mint bindings from answer-support hashes", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        evidence_ids: ["eu-root", "eu-f0"],
        f3_present: false,
        answer_support: { status: "compatible", eligible: true, evidence_ref: "eu-root" }
      }]
    });
    const units = result.graph.nodes.filter((node) => node.kind === "evidence_unit").map((node) => node.id);
    expect(units.sort()).toEqual(["eu-f0", "eu-root"]);
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(result.gaps.some((gap) => gap.kind === "f3_absent")).toBe(true);
  });

  it("records unknown time as a gap and ignores path energy/hop/duplicates", () => {
    const unknownTime = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        temporal: { event_time: null, time_status: "unknown" }
      }]
    });
    expect(unknownTime.gaps.some((gap) => gap.kind === "time_unknown")).toBe(true);

    const withEnergy = pathMaterialization({ strength: 9, hop: 4, path_count: 8 });
    const withoutEnergy = pathMaterialization({});
    expect(withEnergy.graph.digest).toBe(withoutEnergy.graph.digest);
    expect(withEnergy.polarities).toEqual(withoutEnergy.polarities);
    expect(withEnergy.graph.nodes.filter((node) => node.kind === "evidence_unit")).toHaveLength(1);
  });
});
