import { describe, expect, it } from "vitest";
import {
  createCliFallbackFailureResponse,
  createCliFallbackSuccessResponse,
  normalizeCliFallbackRequest,
  normalizeMcpOperationRequest,
  toOperationParityShape
} from "../cli/fallback.js";
import type { AuditedProposalRecordInput } from "../runtime/types.js";
import type { ProposalRecord } from "../provider/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("CLI fallback operation contract helpers", () => {
  it("normalizes CLI fallback payloads to the same operation parity shape as MCP", () => {
    const payload = proposalPayload();
    const cli = normalizeCliFallbackRequest({
      command: ["alaya", "fallback", "provider.proposal.record", "--token=raw-secret"],
      operation: "provider.proposal.record",
      payload
    });
    const mcp = normalizeMcpOperationRequest({
      operation: "provider.proposal.record",
      payload,
      toolName: "alaya.provider.proposal.record"
    });

    expect(cli.transport).toBe("cli-fallback");
    expect(cli.command).toEqual(["alaya", "fallback", "provider.proposal.record", "--token=[REDACTED]"]);
    expect(mcp.transport).toBe("mcp");
    expect(toOperationParityShape(cli)).toEqual(toOperationParityShape(mcp));
    expect(toOperationParityShape(cli)).toMatchObject({
      contract: {
        name: "AlayaRuntimeOperation",
        runtime_method: "recordProposal",
        schema_version: 1
      },
      operation: "provider.proposal.record",
      payload
    });
  });

  it("normalizes success responses without changing the operation contract", () => {
    const request = normalizeCliFallbackRequest({
      operation: "provider.proposal.record",
      payload: proposalPayload()
    });

    const response = createCliFallbackSuccessResponse({
      request,
      result: {
        accepted: true,
        durable_truth: false,
        secret: "token=raw-secret"
      }
    });

    expect(response).toMatchObject({
      ok: true,
      contract: request.contract,
      operation: "provider.proposal.record",
      result: {
        accepted: true,
        durable_truth: false,
        secret: "[REDACTED]"
      }
    });
  });

  it("redacts unsupported operation failures and does not leak secret-looking CLI input", () => {
    let error: unknown;
    try {
      normalizeCliFallbackRequest({
        operation: "unknown.operation --api-key=sk-live-secret-value" as "provider.proposal.record",
        payload: proposalPayload()
      });
    } catch (caught) {
      error = caught;
    }

    const response = createCliFallbackFailureResponse({ error });
    const serialized = JSON.stringify(response);

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("UNSUPPORTED_OPERATION");
    expect(response.error.message).toContain("Unsupported CLI fallback operation");
    expect(serialized).not.toContain("sk-live-secret-value");
    expect(serialized).not.toContain("raw-secret");
    expect(serialized).toContain("[REDACTED]");
  });
});

function proposalPayload(): AuditedProposalRecordInput {
  return {
    evidence: [{ kind: "test", ref: "evidence:cli-fallback" }],
    proposal: validProposal(),
    source: { kind: "test", ref: "source:cli-fallback" },
    workspaceId: "workspace-1"
  };
}

function validProposal(): ProposalRecord {
  return {
    created_at: now,
    durable_truth: false,
    evidence_refs: ["evidence-1"],
    governance_outcome: "candidate",
    lifecycle_state: "candidate",
    proposal_id: "proposal-1",
    proposed_content_ref: "proposal-content-1",
    provider_decision_id: "provider-selection-1",
    rejection_reason: null,
    scope: {
      run_id: "run-1",
      scope_class: "project",
      scope_ref: "workspace-1",
      surface_id: null,
      workspace_id: "workspace-1"
    },
    source: {
      kind: "provider",
      ref: "provider-a"
    },
    source_refs: ["source-1"],
    target_dimension: "fact",
    validation_errors: []
  };
}
