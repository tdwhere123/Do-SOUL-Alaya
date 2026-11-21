import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneObjectKind,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type MemoryEntry,
  type Proposal,
  type RecallCandidate,
  type RecallPolicy,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";

import { createApp } from "../../../runtime/app.js";

import { proposalRouteServices } from "../../support/route-service-stubs.js";

import { ALAYA_SYSEXITS, type AlayaCliContext } from "../../../cli/bridge.js";

import { createReviewCommand } from "../../../cli/review/review.js";

import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";

import { createMcpMemoryProposalWorkflow } from "../../../mcp-memory/proposal/proposal-workflow.js";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../../mcp-memory/tool/tool-handler.js";

import {
  reviewerArgs,
  ReviewParitySurfaces,
  runReviewParityScenario,
  createErrorReviewHandler,
  createReviewHandler,
  createBaseDeps,
  createContext,
  createProposal,
  createParityMemoryEntry,
  _UsedTypes
} from "./proposal-review-parity-fixture.js";

describe("proposal review mcp http cli parity", () => {

  it("returns the same review response shape through MCP, daemon HTTP, and CLI", async () => {
    const mcpResult = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createReviewHandler(),
        contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "inspector", sessionId: "review-parity-mcp-session" })
      },
      "soul.review_memory_proposal",
      reviewerArgs
    );
    const mcpOutput = (mcpResult.structuredContent as { readonly output: unknown }).output;

    const daemonApp = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "daemon-request-token",
        boundWorkspaceIds: ["ws1"],
        allowDesktopOriginlessRequests: true
      },
      routes: {
        proposals: proposalRouteServices({
          workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws1" })) },
          memoryService: { findByIdScoped: vi.fn(async () => null) },
          proposalService: {
            findByWorkspaceId: vi.fn(async () => []),
            findPending: vi.fn(async () => [])
          },
          mcpMemoryToolHandler: createReviewHandler()
        })
      }
    });

    const httpResponse = await daemonApp.request("/workspaces/ws1/proposals/prop-1/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-token": "daemon-request-token",
        "x-alaya-desktop": "1"
      },
      body: JSON.stringify({
        verdict: reviewerArgs.verdict,
        reason: reviewerArgs.reason,
        reviewer_identity: reviewerArgs.reviewer_identity,
        reviewer_token: reviewerArgs.reviewer_token
      })
    });
    expect(httpResponse.status).toBe(200);
    const httpPayload = (await httpResponse.json()) as { readonly data: unknown };

    const cliCommand = createReviewCommand({
      handler: createReviewHandler(),
      defaultWorkspaceId: "ws1",
      defaultReviewerIdentity: "user:server-reviewer",
      defaultReviewerToken: "review-token"
    });
    const parsedCli = cliCommand.argsSchema.safeParse(["accept", "prop-1", "--reason", "approved locally"]);
    expect(parsedCli.success).toBe(true);
    if (!parsedCli.success) return;
    const cliResult = await cliCommand.handler(createContext(), parsedCli.data);

    expect(cliResult.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(mcpOutput).toEqual({
      proposal_id: "prop-1",
      resolution_state: ProposalResolutionState.ACCEPTED
    });
    expect(httpPayload.data).toEqual(mcpOutput);
    expect(cliResult.json).toEqual(mcpOutput);
  });

  it("rejects a review with no reviewer binding and writes no review event", async () => {
    const proposal = createProposal();
    const appendSpy = vi.fn(async () => {
      throw new Error("append must not be called when the reviewer binding is missing");
    });
    const notifySpy = vi.fn(async () => {});
    const updateSpy = vi.fn(async () => {
      throw new Error("resolution must not be written without a reviewer binding");
    });
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => "prop-1",
      // No reviewerIdentityBinding: a network review surface must be rejected
      // rather than forging the audit trail.
      eventLogRepo: { append: appendSpy, queryByEntity: async () => [] },
      proposalRepo: {
        create: async () => proposal,
        createProposalWithEvents: async () => ({ proposal, events: [] }),
        findById: async () => proposal,
        findScopedById: async () => ({
          proposal,
          workspace_id: "ws1",
          run_id: null,
          reviewer_assignment: null,
          proposed_changes: { content: "approved locally" }
        }),
        findPendingSummaries: async () => [],
        countPendingSummaries: async () => 0,
        acceptPendingMemoryUpdateWithEvents: updateSpy,
        updatePendingResolutionWithEvents: updateSpy
      },
      runtimeNotifier: { notifyEntry: notifySpy },
      memoryService: {
        findByIdScoped: async (objectId: string) => ({ object_id: objectId }),
        validateUpdate: async () => {},
        update: async (objectId: string, fields) => createParityMemoryEntry({ object_id: objectId, ...fields })
      }
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: "prop-1",
          verdict: "accept",
          reason: "approved locally",
          reviewer_identity: "user:payload-override"
        },
        {
          workspaceId: "ws1",
          runId: null,
          agentTarget: "inspector",
          sessionId: "inspector-no-binding-review"
        }
      )
    ).rejects.toMatchObject({ code: "VALIDATION", message: "reviewer binding not configured" });

    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
