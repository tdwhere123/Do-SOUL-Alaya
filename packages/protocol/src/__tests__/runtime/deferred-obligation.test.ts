import { describe, expect, it } from "vitest";
import {
  DeferredObligationKindSchema,
  DeferredObligationSchema,
  DeferredObligationStateSchema
} from "../../runtime/deferred-obligation.js";

const validTimestamp = "2026-04-15T00:00:00.000Z";

describe("DeferredObligation schema", () => {
  it("parses a valid deferred obligation and exports stable enums", () => {
    expect(DeferredObligationKindSchema.options).toEqual([
      "safety_finding",
      "data_cleanup",
      "evidence_refresh",
      "governance_pledge"
    ]);
    expect(DeferredObligationStateSchema.options).toEqual([
      "pending",
      "fulfilled",
      "expired",
      "waived"
    ]);

    const obligation = {
      obligation_id: "obligation-1",
      kind: "safety_finding",
      state: "pending",
      description: "Fix outstanding safety finding before completion.",
      source_run_id: "run-1",
      workspace_id: "workspace-1",
      target_entity_id: "claim-1",
      created_at: validTimestamp,
      expires_at: "2026-04-16T00:00:00.000Z"
    } as const;

    expect(DeferredObligationSchema.parse(obligation)).toEqual(obligation);
  });

  it("rejects missing required fields and unknown keys", () => {
    expect(() =>
      DeferredObligationSchema.parse({
        kind: "safety_finding",
        state: "pending",
        description: "Missing required identity fields.",
        source_run_id: "run-1",
        workspace_id: "workspace-1",
        created_at: validTimestamp,
        expires_at: "2026-04-16T00:00:00.000Z"
      })
    ).toThrow();

    expect(() =>
      DeferredObligationSchema.parse({
        obligation_id: "obligation-1",
        kind: "safety_finding",
        state: "pending",
        description: "Unknown field should fail strict schema.",
        source_run_id: "run-1",
        workspace_id: "workspace-1",
        created_at: validTimestamp,
        expires_at: "2026-04-16T00:00:00.000Z",
        extra: "not allowed"
      })
    ).toThrow();
  });
});
