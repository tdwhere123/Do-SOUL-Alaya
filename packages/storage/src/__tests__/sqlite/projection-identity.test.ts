import { describe, expect, it } from "vitest";
import { emptyBytesSha256, emptyJsonArraySha256 } from "@do-soul/alaya-protocol";
import { isCompatibleProjectionIdentity } from "../../sqlite/projection-identity.js";

describe("projection identity empty digests", () => {
  it("treats empty-bytes and empty-array digests as compatible empties", () => {
    const emptyBytes = emptyBytesSha256();
    const emptyArray = emptyJsonArraySha256();
    expect(isCompatibleProjectionIdentity(
      identity(0, emptyBytes),
      identity(0, emptyArray)
    )).toBe(true);
    expect(isCompatibleProjectionIdentity(
      identity(0, emptyBytes),
      identity(0, "a".repeat(64))
    )).toBe(false);
  });
});

function identity(count: number, digest: string) {
  return {
    projection_count: count,
    projection_digest: digest,
    assertion_schema_generation: "relation_assertion_v2",
    assertion_event_contract_generation: "relation_assertion_event_v2",
    projection_schema_generation: "relation_path_projection_v1",
    projection_policy_id: "relation-path-projection-v1",
    projection_policy_sha256: "b".repeat(64)
  };
}
