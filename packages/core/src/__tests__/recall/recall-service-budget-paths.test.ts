import { describe, expect, it } from "vitest";
import { assessEvidence } from "../../recall/conditional-field/evidence/assess-support.js";
import { assessmentInput, demand, observation, template } from
  "./conditional-field/evidence/evidence.fixture.js";

describe("conditional field path evidence governance", () => {
  it.each([0, 1000])("keeps governed evidence eligibility independent of association %s", (association) => {
    const observations = [
      observation({ observation_id: "allowed", evidence_id: "allowed", premise_id: "p-allowed",
        proposition_id: "fact", path_governance: "recall_allowed",
        association_milligrades: association }),
      observation({ observation_id: "strict", evidence_id: "strict", premise_id: "p-strict",
        proposition_id: "fact", path_governance: "strictly_governed",
        association_milligrades: association }),
      observation({ observation_id: "protected", evidence_id: "protected", premise_id: "p-protected",
        proposition_id: "fact", path_governance: "recall_allowed", access: "protected",
        association_milligrades: association })
    ];
    const result = assessEvidence(assessmentInput({
      observations,
      propositions: [demand("fact", "assertion", [
        template("allowed", ["p-allowed"], 1),
        template("strict", ["p-strict"], 1),
        template("protected", ["p-protected"], 1)
      ])]
    }));
    expect(result.governance.find((row) => row.evidence_id === "allowed")?.admitted).toBe(true);
    expect(result.governance.find((row) => row.evidence_id === "strict")).toMatchObject({
      admitted: false, reason: "strictly_governed"
    });
    expect(result.governance.find((row) => row.evidence_id === "protected")).toMatchObject({
      admitted: false, reason: "protected_source"
    });
    expect(result.records[0]?.claim).toBe("supported");
    expect(result.explanation_ids).toEqual(["allowed/supports"]);
  });
});
