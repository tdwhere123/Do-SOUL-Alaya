import { describe, expect, it } from "vitest";
import {
  WorkerDispatchRequestSchema,
  WorkerDispatchResponseSchema
} from "../../index.js";

function createDispatchRequest() {
  return {
    engineClass: "coding_engine" as const,
    subtaskDescription: "Investigate worker drift and report mitigation options.",
    localSurfaceRef: "surface://workspace-1/worker-dispatch",
    localEvidencePointer: "evidence://workspace-1/worker-dispatch",
    restrictedToolSet: ["read_file", "search_files"],
    localBudget: {
      max_worker_delegations: 1,
      max_tool_calls: 3,
      max_output_tokens: 2048,
      max_wall_time_ms: 120000
    },
    agreedReturnFormat: {
      allowed_return_kinds: ["analysis_note", "verification_result"],
      requires_structured_summary: true
    },
    principalSecuritySnapshot: {
      governance_lease_ref: "lease://workspace-1/run-1",
      hard_constraint_refs: ["constraint://worker-dispatch"],
      denied_tool_categories: ["network"]
    },
    sessionConfig: {
      role: "worker" as const,
      workspace_id: "workspace-1",
      run_id: "run-1",
      cwd: "/workspace",
      writable_roots: ["/workspace"],
      tool_profile: "conversation_engine" as const,
      allowed_mcp_servers: ["github"],
      sandbox_policy: "workspace_write" as const,
      permission_policy: "ask" as const,
      network_policy: "restricted" as const
    },
    prompt: "Find drift source and propose concrete remediation."
  };
}

function createDispatchResponse() {
  return {
    worker_run_id: "worker-run-1",
    principal_run_id: "run-1",
    workspace_id: "workspace-1",
    requesting_run_id: "run-1",
    engine_class: "coding_engine" as const,
    state: "init" as const,
    subtask_description: "Investigate worker drift and report mitigation options.",
    local_surface_ref: "surface://workspace-1/worker-dispatch",
    local_evidence_pointer: "evidence://workspace-1/worker-dispatch",
    restricted_tool_set: ["read_file", "search_files"],
    local_budget: {
      max_worker_delegations: 1,
      max_tool_calls: 3,
      max_output_tokens: 2048,
      max_wall_time_ms: 120000
    },
    agreed_return_format: {
      allowed_return_kinds: ["analysis_note", "verification_result"],
      requires_structured_summary: true
    },
    principal_security_snapshot: {
      governance_lease_ref: "lease://workspace-1/run-1",
      hard_constraint_refs: ["constraint://worker-dispatch"],
      denied_tool_categories: ["network"]
    },
    created_at: "2026-04-24T00:00:00.000Z",
    updated_at: "2026-04-24T00:00:00.000Z"
  };
}

describe("Worker dispatch contract", () => {
  it("parses a valid worker dispatch request payload", () => {
    expect(WorkerDispatchRequestSchema.parse(createDispatchRequest())).toEqual(createDispatchRequest());
  });

  it("normalizes caller-facing string fields through the shared request schema", () => {
    expect(
      WorkerDispatchRequestSchema.parse({
        ...createDispatchRequest(),
        subtaskDescription: "  Investigate worker drift.  ",
        localSurfaceRef: " surface://workspace-1/worker-dispatch ",
        localEvidencePointer: " evidence://workspace-1/worker-dispatch ",
        restrictedToolSet: [" read_file "],
        principalSecuritySnapshot: {
          ...createDispatchRequest().principalSecuritySnapshot,
          governance_lease_ref: " lease://workspace-1/run-1 ",
          hard_constraint_refs: [" constraint://worker-dispatch "]
        },
        prompt: " Find drift source. "
      })
    ).toMatchObject({
      subtaskDescription: "Investigate worker drift.",
      localSurfaceRef: "surface://workspace-1/worker-dispatch",
      localEvidencePointer: "evidence://workspace-1/worker-dispatch",
      restrictedToolSet: ["read_file"],
      principalSecuritySnapshot: {
        governance_lease_ref: "lease://workspace-1/run-1",
        hard_constraint_refs: ["constraint://worker-dispatch"]
      },
      prompt: "Find drift source."
    });
  });

  it("rejects whitespace-only request payload strings", () => {
    const result = WorkerDispatchRequestSchema.safeParse({
      ...createDispatchRequest(),
      subtaskDescription: "   "
    });

    expect(result.success).toBe(false);
  });

  it("rejects request payloads with unsupported return kinds", () => {
    const result = WorkerDispatchRequestSchema.safeParse({
      ...createDispatchRequest(),
      agreedReturnFormat: {
        allowed_return_kinds: ["analysis_note", "not_supported"],
        requires_structured_summary: true
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects request payloads with unsupported denied tool categories", () => {
    const result = WorkerDispatchRequestSchema.safeParse({
      ...createDispatchRequest(),
      principalSecuritySnapshot: {
        ...createDispatchRequest().principalSecuritySnapshot,
        denied_tool_categories: ["network", "not_a_category"]
      }
    });

    expect(result.success).toBe(false);
  });

  it("parses worker dispatch response payloads", () => {
    expect(WorkerDispatchResponseSchema.parse(createDispatchResponse())).toEqual(createDispatchResponse());
  });
});
