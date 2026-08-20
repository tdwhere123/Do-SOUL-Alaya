import { describe, expect, it } from "vitest";
import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  hashFactorId
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";

const CLOCK = "2026-08-16T00:00:00.000Z";

describe("field store factor replay", () => {
  it("compares hashed factor identity and refuses a null-payload wildcard", () => {
    const stores = createInMemoryFieldStores();
    const identity = hashFactorId({
      family: "f0",
      canonical_payload: "atlas",
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID
    }, fieldContractSha256);
    const live = descriptor(identity, "atlas");
    expect(stores.putDescriptor(live)).toEqual(live);
    expect(stores.putDescriptor(live)).toEqual(live);
    expect(() => stores.putDescriptor(descriptor(identity, null))).toThrow(/factor/iu);
  });
});

function descriptor(identity: string, payload: string | null) {
  return {
    schema_version: 1 as const,
    producer: FACTOR_INCIDENCE_OPERATOR_ID,
    consumer: "projection_generation",
    identity,
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "retain_identity" as const,
    workspace_id: "workspace-1",
    family: "f0" as const,
    canonical_payload: payload,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: CLOCK
  };
}
