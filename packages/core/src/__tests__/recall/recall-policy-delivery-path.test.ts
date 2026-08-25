import { describe, expect, it } from "vitest";
import { ScopeClass } from "@do-soul/alaya-protocol";
import { buildRecallPolicy } from "../../shared/recall-policy.js";

describe("recall policy delivery path", () => {
  it("passes optional legacy rollback through the public builder", () => {
    const omitted = buildRecallPolicy({
      runtimeId: "policy-omitted",
      taskSurfaceId: "surface-omitted",
      maxResults: 5,
      filters: { scopeFilter: [ScopeClass.PROJECT], dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: true,
      maxTotalTokens: 2_000
    });
    const rollback = buildRecallPolicy({
      runtimeId: "policy-legacy",
      taskSurfaceId: "surface-legacy",
      maxResults: 5,
      filters: { scopeFilter: [ScopeClass.PROJECT], dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: true,
      maxTotalTokens: 2_000,
      deliveryPath: "legacy"
    });
    expect(omitted.fine_assessment.delivery_path).toBeUndefined();
    expect(rollback.fine_assessment.delivery_path).toBe("legacy");
  });
});
