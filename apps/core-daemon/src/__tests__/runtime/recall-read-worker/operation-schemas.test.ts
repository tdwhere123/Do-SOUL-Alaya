import { describe, expect, expectTypeOf, it } from "vitest";
import { encodeAuthorizedScopesAdmission } from "@do-soul/alaya-core";
import { SoulActiveConstraintSchema } from "@do-soul/alaya-protocol";
import {
  BoundedRequestSchema,
  parseConditionalFieldRecallPayload,
  parseWorkerOperation,
  parseWorkerOperationPayload,
  parseWorkerOperationResult,
  type ParsedWorkerOperation,
  type WorkerOperationPayload
} from "../../../runtime/recall-read-worker/operation-schemas.js";
import {
  RECALL_READ_WORKER_OPERATIONS,
  type RecallReadWorkerOperation
} from "../../../runtime/recall-read-worker/protocol.js";

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
    const payload = parseWorkerOperationPayload("constraints.findActive", {
      workspaceId: "workspace-1",
      cap: 8
    }) satisfies WorkerOperationPayload<"constraints.findActive">;
    expect(payload).toMatchObject({ workspaceId: "workspace-1", cap: 8 });
    expect(() => parseWorkerOperationPayload("constraints.findActive", { workspaceId: 1 })).toThrow();
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
    expect(() => parseWorkerOperationPayload("constraints.findActive", {
      workspaceId: "workspace-1",
      extra: true
    })).toThrow();
  });

  it("rejects private source controls while retaining native preparation", () => {
    const payload = { workspace_id: "workspace-1", as_of: CLOCK,
      authorized_scopes: { mode: "named", scopes: ["project"] },
      request: { kind: "prepare_source", source_id: "source-1", budget: recallPayload(undefined).budget } };
    expect(parseWorkerOperationPayload("conditionalField.sourceSemantics", payload)).toEqual(payload);
    for (const control of ["acquisition_control", "joint_control", "qualified_control"]) {
      expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", { ...payload, [control]: "lexical" })).toThrow();
    }
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

  it("admits only a shared single-word acknowledgment arbitration cell", () => {
    const payload = { preparation_id: "prep-1", issued_entry_ids: [], previews: {} };
    const settlement = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    expect(parseWorkerOperationPayload("conditionalField.acknowledge", { ...payload, settlement }))
      .toHaveProperty("settlement", settlement);
    for (const invalid of [new ArrayBuffer(4), new SharedArrayBuffer(0), new SharedArrayBuffer(8), [0]]) {
      expect(() => parseWorkerOperationPayload("conditionalField.acknowledge", { ...payload, settlement: invalid })).toThrow();
    }
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

  it("keeps parse-owner operation/payload pairing and rejects illegal pairs at compile time", () => {
    const parsed = parseWorkerOperation("constraints.findActive", {
      workspaceId: "workspace-1",
      cap: 8
    });
    expect(parsed).toEqual({
      operation: "constraints.findActive",
      payload: {
        workspaceId: "workspace-1",
        cap: 8
      }
    });
    expect(() => parseWorkerOperation("constraints.findActive", {
      workspaceId: "workspace-1",
      queryText: "needle",
      limit: 3
    })).toThrow();

    type ConstraintCall = ParsedWorkerOperation<"constraints.findActive">;
    type ConstraintOperation = Extract<RecallReadWorkerOperation, `constraints.${string}`>;
    type IllegalKeywordOnFindActive = {
      readonly operation: "constraints.findActive";
      readonly payload: WorkerOperationPayload<"ready">;
    };
    type UncorrelatedConstraintCall = {
      readonly operation: ConstraintOperation;
      readonly payload: WorkerOperationPayload<ConstraintOperation>;
    };
    type Extends<A, B> = [A] extends [B] ? true : false;
    const consumerRejectsMismatchedPair: Extends<IllegalKeywordOnFindActive, ConstraintCall> = false;
    const uncorrelatedWouldAcceptMismatchedPair: Extends<
      IllegalKeywordOnFindActive,
      UncorrelatedConstraintCall
    > = false;
    const consumerAcceptsLegalPair: Extends<{
      readonly operation: "constraints.findActive";
      readonly payload: WorkerOperationPayload<"constraints.findActive">;
    }, ConstraintCall> = true;
    expect(consumerRejectsMismatchedPair).toBe(false);
    expect(uncorrelatedWouldAcceptMismatchedPair).toBe(false);
    expect(consumerAcceptsLegalPair).toBe(true);
    expectTypeOf(parsed).toEqualTypeOf<ParsedWorkerOperation<"constraints.findActive">>();
    expectTypeOf<IllegalKeywordOnFindActive>().not.toMatchTypeOf<ConstraintCall>();
    acceptParsedWorkerOperation(parsed);
    acceptParsedWorkerOperation({
      operation: "ready",
      payload: {}
    });
    // @ts-expect-error ready payload is not valid for findActive
    acceptParsedWorkerOperation({
      operation: "constraints.findActive",
      payload: {}
    });
    // @ts-expect-error ready does not accept a findActive payload
    acceptParsedWorkerOperation({
      operation: "ready",
      payload: {
        workspaceId: "workspace-1",
        cap: 8
      }
    });
  });
});

function acceptParsedWorkerOperation(parsed: ParsedWorkerOperation): ParsedWorkerOperation {
  return parsed;
}
