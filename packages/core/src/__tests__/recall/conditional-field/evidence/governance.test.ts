import { describe, expect, it } from "vitest";
import {
  assessEvidence,
  evaluateGovernance,
  observationsFromOwners
} from "../../../../recall/conditional-field/evidence/assess-support.js";
import {
  AS_OF,
  OPEN_VALIDITY,
  SOURCE_REVISION,
  assessmentInput,
  demand,
  identityContext,
  observation,
  template
} from "./evidence.fixture.js";

describe("conditional-field evidence governance", () => {
  it("does not let an eligible path launder a protected source into support or explanations", () => {
    const protectedObs = observation({
      observation_id: "secret",
      evidence_id: "e-secret",
      premise_id: "p1",
      proposition_id: "fact",
      access: "protected",
      source_id: "classified",
      path_governance: "recall_allowed"
    });
    const eligible = observation({
      observation_id: "public",
      evidence_id: "e-public",
      premise_id: "p2",
      proposition_id: "fact"
    });
    const assessed = assessEvidence(assessmentInput({
      observations: [protectedObs, eligible],
      propositions: [demand("fact", "assertion", [
        template("leaky", ["p1", "p2"], 50),
        template("public", ["p2"], 50)
      ])]
    }));
    expect(assessed.governance.find((row) => row.evidence_id === "e-secret")).toMatchObject({
      admitted: false,
      reason: "protected_source"
    });
    expect(assessed.records[0]?.claim).toBe("supported");
    expect(assessed.explanation_ids).toEqual(["public/supports"]);
    expect(assessed.explanation_ids.join(" ")).not.toContain("secret");
    expect(assessed.explanation_ids).not.toContain("leaky/supports");
  });

  it("rejects ineligible sources even when they appear as explanation premises", () => {
    const assessed = assessEvidence(assessmentInput({
      observations: [
        observation({
          observation_id: "denied",
          evidence_id: "e-denied",
          premise_id: "p1",
          proposition_id: "fact",
          access: "ineligible"
        })
      ],
      propositions: [demand("fact", "assertion", [template("only", ["p1"], 10)])]
    }));
    expect(assessed.governance[0]?.reason).toBe("ineligible_source");
    expect(assessed.records[0]?.claim).toBe("unknown");
    expect(assessed.explanation_ids).toEqual([]);
  });

  it("makes temporal invalidity and source-revision mismatch observable", () => {
    const temporal = evaluateGovernance(
      observation({
        observation_id: "old",
        evidence_id: "e-old",
        premise_id: "p1",
        proposition_id: "fact",
        validity: {
          kind: "bounded",
          valid_from: "2026-01-01T00:00:00.000Z",
          valid_to: "2026-02-01T00:00:00.000Z"
        }
      }),
      identityContext()
    );
    expect(temporal).toMatchObject({ admitted: false, reason: "temporal_invalid" });
    const revision = evaluateGovernance(
      observation({
        observation_id: "stale",
        evidence_id: "e-stale",
        premise_id: "p1",
        proposition_id: "fact",
        source_id: "src",
        source_revision: "rev-0"
      }),
      identityContext({ source_revisions: new Map([["src", SOURCE_REVISION]]) })
    );
    expect(revision).toMatchObject({ admitted: false, reason: "source_revision_mismatch" });
    const missing = evaluateGovernance(
      observation({
        observation_id: "blank",
        evidence_id: "e-blank",
        premise_id: "p1",
        proposition_id: "fact",
        source_revision: ""
      }),
      identityContext()
    );
    expect(missing).toMatchObject({ admitted: false, reason: "source_revision_mismatch" });
    const snapshot = evaluateGovernance(
      observation({
        observation_id: "other-q",
        evidence_id: "e-q",
        premise_id: "p1",
        proposition_id: "fact",
        query_id: "other-query"
      }),
      identityContext()
    );
    expect(snapshot).toMatchObject({ admitted: false, reason: "identity_mismatch" });
  });

  it("does not admit strictly governed or inactive paths", () => {
    expect(evaluateGovernance(
      observation({
        observation_id: "gov",
        evidence_id: "e-gov",
        premise_id: "p1",
        proposition_id: "fact",
        path_governance: "strictly_governed"
      }),
      identityContext()
    ).reason).toBe("strictly_governed");
    expect(evaluateGovernance(
      observation({
        observation_id: "dormant",
        evidence_id: "e-dormant",
        premise_id: "p1",
        proposition_id: "fact",
        path_lifecycle: "dormant"
      }),
      identityContext()
    ).reason).toBe("path_inactive");
  });

  it("maps relation assertions and attributable claims without minting a second ledger", () => {
    const context = identityContext();
    const mapped = observationsFromOwners({
      ...context,
      assertions: [{
        assertion_id: "assert-1",
        relation_kind: "contradicts",
        evidence_receipts: [{
          evidence_id: "e-assert",
          source_event_anchor: {
            event_id: "evt-1",
            event_type: "soul.signal.emitted",
            occurred_at: AS_OF
          }
        }],
        anchors: {
          source_anchor: { kind: "object", object_id: "obj-a" },
          target_anchor: { kind: "object", object_id: "obj-b" }
        },
        validity: OPEN_VALIDITY,
        formation_receipt: {
          source_observations: [{ source_id: "evt-1", source_sha256: SOURCE_REVISION }]
        }
      }],
      claims: [{
        object_id: "claim-1",
        claim_kind: "factual_policy",
        claim_status: "active",
        proposition_digest: "digest-1",
        evidence_refs: ["e-claim"],
        source_object_refs: ["obj-a"]
      }, {
        object_id: "claim-draft",
        claim_kind: "factual_policy",
        claim_status: "draft",
        proposition_digest: "digest-draft",
        evidence_refs: ["e-draft"],
        source_object_refs: ["obj-a"]
      }],
      access: new Map([["obj-a", "protected"]])
    });
    expect([...new Set(mapped.map((row) => row.evidence_id))].sort()).toEqual(["e-assert", "e-claim"]);
    expect(mapped.find((row) => row.evidence_id === "e-assert")?.polarity).toBe("refutes");
    expect(mapped.every((row) => row.access === "protected")).toBe(true);
    expect(mapped.filter((row) => row.evidence_id === "e-assert").every((row) => row.source_revision === SOURCE_REVISION)).toBe(true);
    expect(mapped.filter((row) => row.evidence_id === "e-claim").every((row) => row.source_revision === "")).toBe(true);
    expect(mapped.some((row) => row.evidence_id === "e-draft")).toBe(false);
  });

  it("keeps formation source revisions distinct and fails closed without access or formation", () => {
    const first = observationsFromOwners({
      ...identityContext(),
      assertions: [{
        assertion_id: "assert-a",
        relation_kind: "associated_config",
        evidence_receipts: [{
          evidence_id: "e-a",
          source_event_anchor: { event_id: "evt-a", event_type: "soul.signal.emitted", occurred_at: AS_OF }
        }],
        anchors: {
          source_anchor: { kind: "object", object_id: "obj-a" },
          target_anchor: { kind: "object", object_id: "obj-b" }
        },
        validity: OPEN_VALIDITY,
        formation_receipt: {
          source_observations: [{ source_id: "evt-a", source_sha256: "rev-a" }]
        }
      }, {
        assertion_id: "assert-b",
        relation_kind: "associated_config",
        evidence_receipts: [{
          evidence_id: "e-b",
          source_event_anchor: { event_id: "evt-b", event_type: "soul.signal.emitted", occurred_at: AS_OF }
        }],
        anchors: {
          source_anchor: { kind: "object", object_id: "obj-c" },
          target_anchor: { kind: "object", object_id: "obj-d" }
        },
        validity: OPEN_VALIDITY,
        formation_receipt: {
          source_observations: [{ source_id: "evt-b", source_sha256: "rev-b" }]
        }
      }],
      claims: [],
      access: new Map([["e-a", "eligible"], ["obj-a", "eligible"], ["obj-b", "eligible"],
        ["e-b", "eligible"], ["obj-c", "eligible"], ["obj-d", "eligible"]])
    });
    expect(new Set(first.map((row) => row.source_revision))).toEqual(new Set(["rev-a", "rev-b"]));
    expect(first.every((row) => row.source_revision !== identityContext().snapshot_id)).toBe(true);
    const closed = observationsFromOwners({
      ...identityContext(),
      assertions: [{
        assertion_id: "assert-missing",
        relation_kind: "associated_config",
        evidence_receipts: [{
          evidence_id: "e-missing",
          source_event_anchor: { event_id: "evt-missing", event_type: "soul.signal.emitted", occurred_at: AS_OF }
        }],
        anchors: {
          source_anchor: { kind: "object", object_id: "obj-a" },
          target_anchor: { kind: "object", object_id: "obj-b" }
        },
        validity: OPEN_VALIDITY
      }],
      claims: [],
      access: new Map()
    });
    expect(closed.every((row) => row.source_revision === "")).toBe(true);
    expect(closed.every((row) => row.access === "ineligible")).toBe(true);
    expect(evaluateGovernance(closed[0]!, identityContext()).reason).toBe("source_revision_mismatch");
  });

  it("admits a formation observation when only source and target objects are in-scope", () => {
    const mapped = observationsFromOwners({
      ...identityContext(),
      assertions: [{
        assertion_id: "assert-named",
        relation_kind: "associated_config",
        evidence_receipts: [{
          evidence_id: "e-named",
          source_event_anchor: { event_id: "evt-named", event_type: "soul.signal.emitted", occurred_at: AS_OF }
        }],
        anchors: {
          source_anchor: { kind: "object", object_id: "obj-a" },
          target_anchor: { kind: "object", object_id: "obj-b" }
        },
        validity: OPEN_VALIDITY,
        formation_receipt: {
          source_observations: [{ source_id: "evt-named", source_sha256: SOURCE_REVISION }]
        }
      }],
      claims: [],
      access: new Map([["obj-a", "eligible"], ["obj-b", "eligible"]])
    });
    expect(mapped.some((row) => row.evidence_id === "e-named")).toBe(true);
    expect(mapped.every((row) => row.access === "eligible")).toBe(true);
    expect(mapped.every((row) => evaluateGovernance(row, identityContext()).admitted)).toBe(true);
  });
});
