import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TEMPORAL_RELATION_PROJECTION_POLICY_SHA256,
  TEMPORAL_RELATION_PROJECTION_PROFILES
} from "../../relations/relation-projection-policy.js";

const LOCKED_TEMPORAL_RELATION_PROJECTION_POLICY_SHA256 =
  "f68603e497a8d762e5d0ed96e8cd9608475794ccef92c6c3fbc37b76daea7ee7";

describe("temporal relation projection policy identity", () => {
  it("is the live SHA-256 of the projection profile material", () => {
    expect(TEMPORAL_RELATION_PROJECTION_POLICY_SHA256).toBe(
      createHash("sha256")
        .update(JSON.stringify(TEMPORAL_RELATION_PROJECTION_PROFILES))
        .digest("hex")
    );
    expect(
      TEMPORAL_RELATION_PROJECTION_POLICY_SHA256,
      "temporal relation projection profiles changed; bump this lock after reviewing cutover identity"
    ).toBe(LOCKED_TEMPORAL_RELATION_PROJECTION_POLICY_SHA256);
  });
});
