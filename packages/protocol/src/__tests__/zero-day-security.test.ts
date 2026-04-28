import { describe, expect, it } from "vitest";
import { ZeroDayPolicyKindSchema, ZeroDayPolicySchema } from "../zero-day-security.js";

describe("ZeroDayPolicySchema", () => {
  it("parses active and indefinite zero-day policies", () => {
    const timedPolicy = {
      policy_id: "policy-1",
      kind: "deny_category",
      target: "write",
      reason: "emergency write lockdown",
      effective_at: "2026-04-14T00:00:00.000Z",
      expires_at: "2026-04-15T00:00:00.000Z"
    } as const;
    const indefinitePolicy = {
      policy_id: "policy-2",
      kind: "hard_stop",
      target: "operator-stop",
      reason: "operator requested stop",
      effective_at: "2026-04-14T00:00:00.000Z",
      expires_at: null
    } as const;

    expect(ZeroDayPolicySchema.parse(timedPolicy)).toEqual(timedPolicy);
    expect(ZeroDayPolicySchema.parse(indefinitePolicy)).toEqual(indefinitePolicy);
  });

  it("rejects missing identifiers and unknown kinds", () => {
    expect(() =>
      ZeroDayPolicySchema.parse({
        kind: "deny_category",
        target: "write",
        reason: "missing id",
        effective_at: "2026-04-14T00:00:00.000Z",
        expires_at: null
      })
    ).toThrow();

    expect(() => ZeroDayPolicyKindSchema.parse("deny_workspace")).toThrow();
  });

  it("rejects malformed category targets and contradictory time windows", () => {
    expect(() =>
      ZeroDayPolicySchema.parse({
        policy_id: "policy-invalid-category",
        kind: "deny_category",
        target: "writes",
        reason: "typo in category",
        effective_at: "2026-04-14T00:00:00.000Z",
        expires_at: null
      })
    ).toThrow();

    expect(() =>
      ZeroDayPolicySchema.parse({
        policy_id: "policy-invalid-window",
        kind: "hard_stop",
        target: "operator-stop",
        reason: "contradictory time window",
        effective_at: "2026-04-15T00:00:00.000Z",
        expires_at: "2026-04-15T00:00:00.000Z"
      })
    ).toThrow();
  });
});
