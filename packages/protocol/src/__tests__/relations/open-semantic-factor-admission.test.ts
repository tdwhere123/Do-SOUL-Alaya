import { describe, expect, it } from "vitest";
import {
  OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION,
  OpenSemanticFactorFormationAdmissionSchema,
  OpenSemanticFactorFormationProposalSchema,
  OpenSemanticFactorFormationRejectedAdmissionSchema,
  isOpenSemanticFactorFormationProposal,
  isRejectedOpenSemanticFactorFormationAdmission
} from "../../relations/open-semantic-factor-graph.js";

describe("open semantic factor formation admission", () => {
  it("owns rejected admission as a kind discriminant", () => {
    expect(OpenSemanticFactorFormationRejectedAdmissionSchema.parse(
      OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION
    )).toEqual({ kind: "rejected" });
    expect(isRejectedOpenSemanticFactorFormationAdmission(
      OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION
    )).toBe(true);
    expect(OpenSemanticFactorFormationAdmissionSchema.safeParse({
      kind: "rejected"
    }).success).toBe(true);
  });

  it("does not coerce status-shaped objects into rejected admission", () => {
    expect(isRejectedOpenSemanticFactorFormationAdmission({
      status: "rejected"
    })).toBe(false);
    expect(isRejectedOpenSemanticFactorFormationAdmission({
      status: "unavailable"
    })).toBe(false);
    expect(OpenSemanticFactorFormationAdmissionSchema.safeParse({
      status: "rejected"
    }).success).toBe(false);
    expect(OpenSemanticFactorFormationAdmissionSchema.safeParse({
      status: "unavailable"
    }).success).toBe(false);
    expect(OpenSemanticFactorFormationRejectedAdmissionSchema.safeParse({
      kind: "rejected",
      reason: "source_grounding_rejected"
    }).success).toBe(false);
  });

  it("does not treat graph-bearing malformed objects as admission", () => {
    const malformed = [
      { graph: { schema_version: 2 } },
      { status: "rejected", graph: { schema_version: 2 } },
      { kind: "rejected", graph: { schema_version: 2 } },
      { kind: "unavailable", graph: { schema_version: 2 } }
    ] as const;
    for (const value of malformed) {
      expect(isOpenSemanticFactorFormationProposal(value)).toBe(false);
      expect(isRejectedOpenSemanticFactorFormationAdmission(value)).toBe(false);
      expect(OpenSemanticFactorFormationAdmissionSchema.safeParse(value).success)
        .toBe(false);
      expect(OpenSemanticFactorFormationProposalSchema.safeParse(value).success)
        .toBe(false);
    }
  });
});
