import { describe, expect, it } from "vitest";
import { encodeAuthorizedScopesAdmission } from "@do-soul/alaya-core";
import { SoulActiveConstraintSchema } from "@do-soul/alaya-protocol";
import {
  BoundedRequestSchema,
  parseConditionalFieldRecallPayload,
  parseWorkerOperationPayload,
  parseWorkerOperationResult
} from "../../../runtime/recall-read-worker/operation-schemas.js";
import { RECALL_READ_WORKER_OPERATIONS } from "../../../runtime/recall-read-worker/protocol.js";

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
    expect(encodeAuthorizedScopesAdmission(null)).toEqual({ mode: "unrestricted" });
    expect(encodeAuthorizedScopesAdmission(undefined)).toEqual({ mode: "denied" });
    expect(encodeAuthorizedScopesAdmission([])).toEqual({ mode: "denied" });
    expect(encodeAuthorizedScopesAdmission(["project"])).toEqual({ mode: "named", scopes: ["project"] });
  });

  it("rejects unknown keys on the strict payload group", () => {
    expect(() => parseWorkerOperationPayload("ready", { extra: true })).toThrow();
    expect(() => parseWorkerOperationPayload("close", { extra: true })).toThrow();
    expect(() => parseWorkerOperationPayload("snapshot.commit", { extra: true })).toThrow();
    expect(() => parseWorkerOperationPayload("memory.searchManyByKeywordWithinObjectIds", {
      workspaceId: "workspace-1",
      queries: [{ queryText: "needle", limit: 3 }],
      objectIds: ["aaaaaaaa-aaaa-4aaa-8aaa-000000000001"],
      extra: true
    })).toThrow();
  });

  it("rejects a missing result field on the main-thread schema", () => {
    const constraint = SoulActiveConstraintSchema.parse({
      object_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      object_kind: "memory_entry",
      content: "Keep the audit trail.",
      dimension: "constraint",
      scope_class: "project",
      governance_state: {
        claim_status: "active",
        governance_class: "strictly_governed",
        source_channels: ["claim_status"]
      }
    });
    expect(parseWorkerOperationResult("constraints.findActive", {
      constraints: [constraint],
      total_count: 1
    })).toMatchObject({ total_count: 1 });
    expect(() => parseWorkerOperationResult("constraints.findActive", {
      constraints: [constraint]
    })).toThrow();
    expect(() => parseWorkerOperationResult("constraints.findActive", {
      constraints: [constraint],
      total_count: 1,
      extra: true
    })).toThrow();
    expect(() => parseWorkerOperationResult("ready", undefined)).toThrow();
  });

  it("covers a result schema for every worker operation", () => {
    for (const operation of RECALL_READ_WORKER_OPERATIONS) {
      expect(() => parseWorkerOperationResult(operation, { not: "a valid result" })).toThrow();
    }
  });

  it("keeps acknowledge payloads free of the delivered index", () => {
    expect(() => parseWorkerOperationPayload("conditionalField.acknowledge", {
      preparation_id: "prep-1",
      index: { schema_version: 1 },
      issued_entry_ids: [],
      previews: {}
    })).toThrow();
    expect(parseWorkerOperationPayload("conditionalField.acknowledge", {
      preparation_id: "prep-1",
      issued_entry_ids: ["entry-1"],
      previews: { "entry-1": "preview" }
    })).toMatchObject({ preparation_id: "prep-1", issued_entry_ids: ["entry-1"] });
  });

  it("treats omitted and empty bounded scopes as denied", () => {
    expect(BoundedRequestSchema.parse({
      workspaceId: "workspace-1",
      asOf: CLOCK,
      nativeLimit: 8,
      byteLimit: 4096
    }).authorizedScopes).toBeUndefined();
    expect(() => BoundedRequestSchema.parse({
      workspaceId: "workspace-1",
      asOf: CLOCK,
      nativeLimit: 8,
      byteLimit: 4096,
      authorizedScopes: []
    })).toThrow();
  });
});
