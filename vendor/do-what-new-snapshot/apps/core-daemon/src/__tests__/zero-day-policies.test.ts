import { describe, expect, it } from "vitest";
import { parseZeroDayPoliciesJson } from "../zero-day-policies.js";

describe("parseZeroDayPoliciesJson", () => {
  it("returns an empty list when the env var is unset or blank", () => {
    expect(parseZeroDayPoliciesJson(undefined)).toEqual([]);
    expect(parseZeroDayPoliciesJson("   ")).toEqual([]);
  });

  it("parses and validates zero-day policies eagerly", () => {
    expect(
      parseZeroDayPoliciesJson(
        JSON.stringify([
          {
            policy_id: "policy-1",
            kind: "deny_category",
            target: "write",
            reason: "emergency write lockdown",
            effective_at: "2026-04-14T00:00:00.000Z",
            expires_at: null
          }
        ])
      )
    ).toEqual([
      {
        policy_id: "policy-1",
        kind: "deny_category",
        target: "write",
        reason: "emergency write lockdown",
        effective_at: "2026-04-14T00:00:00.000Z",
        expires_at: null
      }
    ]);
  });

  it("rejects malformed policy objects at load time", () => {
    expect(() =>
      parseZeroDayPoliciesJson(
        JSON.stringify([
          {
            policy_id: "policy-1",
            kind: "deny_workspace",
            target: "write",
            reason: "invalid kind",
            effective_at: "2026-04-14T00:00:00.000Z",
            expires_at: null
          }
        ])
      )
    ).toThrow("ZERO_DAY_POLICIES_JSON contains an invalid policy.");
  });
});
