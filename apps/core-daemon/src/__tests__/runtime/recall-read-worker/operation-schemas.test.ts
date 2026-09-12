import { describe, expect, it } from "vitest";
import {
  encodeAuthorizedScopesAdmission,
  parseConditionalFieldRecallPayload,
  parseWorkerOperationPayload
} from "../../../runtime/recall-read-worker/operation-schemas.js";

const CLOCK = "2026-09-10T00:00:00.000Z";

function recallPayload(authorized_scopes: unknown) {
  return {
    workspace_id: "workspace-1",
    query_text: "needle",
    budget: {
      schema_version: 1 as const,
      work_units: 10_000,
      memory_bytes: 1_000_000,
      page_budget: 100,
      finalization_reserve: 100,
      min_envelope: 10
    },
    snapshot_id: `sha256:${"a".repeat(64)}`,
    interpretation_clock: CLOCK,
    as_of: CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z",
    lifetime_now: CLOCK,
    protocol_version: 1 as const,
    supports_source_evidence: true,
    supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    authorized_scopes
  };
}

describe("recall read worker operation schemas", () => {
  it("parses each worker op payload with Zod and keeps JSON null from flipping denied to unrestricted", () => {
    expect(parseWorkerOperationPayload("memory.findByIds", {
      workspaceId: "workspace-1",
      objectIds: ["aaaaaaaa-aaaa-4aaa-8aaa-000000000001"]
    })).toMatchObject({ workspaceId: "workspace-1" });
    expect(() => parseWorkerOperationPayload("memory.findByIds", { workspaceId: 1 })).toThrow();
    const omitted = JSON.parse(JSON.stringify({
      ...recallPayload(undefined),
      authorized_scopes: undefined
    })) as Record<string, unknown>;
    delete omitted.authorized_scopes;
    expect(parseConditionalFieldRecallPayload(omitted).authorized_scopes).toBeUndefined();
    expect(() => parseConditionalFieldRecallPayload(
      JSON.parse(JSON.stringify(recallPayload(null)))
    )).toThrow();
    expect(parseConditionalFieldRecallPayload(
      JSON.parse(JSON.stringify(recallPayload({ mode: "denied" })))
    ).authorized_scopes).toEqual({ mode: "denied" });
    expect(parseConditionalFieldRecallPayload(
      JSON.parse(JSON.stringify(recallPayload({ mode: "unrestricted" })))
    ).authorized_scopes).toEqual({ mode: "unrestricted" });
    expect(parseConditionalFieldRecallPayload(
      JSON.parse(JSON.stringify(recallPayload({ mode: "named", scopes: ["project"] })))
    ).authorized_scopes).toEqual({ mode: "named", scopes: ["project"] });
  });

  it("encodes in-process tri-state to the explicit admission enum before IPC", () => {
    // TypeScript null is unrestricted; IPC JSON null is a different, denied path.
    expect(encodeAuthorizedScopesAdmission(null)).toEqual({ mode: "unrestricted" });
    expect(encodeAuthorizedScopesAdmission(undefined)).toEqual({ mode: "denied" });
    expect(encodeAuthorizedScopesAdmission([])).toEqual({ mode: "denied" });
    expect(encodeAuthorizedScopesAdmission(["project"])).toEqual({ mode: "named", scopes: ["project"] });
  });
});
