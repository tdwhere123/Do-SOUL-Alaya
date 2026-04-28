import { describe, expect, it } from "vitest";
import {
  ConstitutionalFragmentCategorySchema,
  ConstitutionalFragmentIdSchema,
  ConstitutionalFragmentRegisteredPayloadSchema,
  ConstitutionalFragmentSchema,
  listConstitutionalFragmentIdentityParts
} from "../index.js";

describe("constitutional fragment identity helpers", () => {
  it("exports a dedicated fragment id parser without changing runtime string behavior", () => {
    expect(ConstitutionalFragmentCategorySchema.parse("hard_constraint")).toBe("hard_constraint");
    expect(ConstitutionalFragmentIdSchema.parse("fragment-1")).toBe("fragment-1");
  });

  it("serializes fragment identity parts in the protocol-owned hashing order", () => {
    expect(
      listConstitutionalFragmentIdentityParts({
        workspace_id: "workspace-1",
        category: "hard_constraint",
        authority_source: "system.worker_dispatch",
        content: "Always verify file ownership before editing."
      })
    ).toEqual([
      "workspace-1",
      "hard_constraint",
      "system.worker_dispatch",
      "Always verify file ownership before editing."
    ]);
  });

  it("wires the dedicated fragment id schema through the public fragment contracts", () => {
    expect(ConstitutionalFragmentSchema.unwrap().shape.fragment_id).toBe(
      ConstitutionalFragmentIdSchema
    );
    expect(ConstitutionalFragmentRegisteredPayloadSchema.unwrap().shape.fragment_id).toBe(
      ConstitutionalFragmentIdSchema
    );
  });
});
