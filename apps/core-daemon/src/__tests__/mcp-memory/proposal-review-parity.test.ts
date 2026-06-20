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

import { createApp } from "../../runtime/app.js";

import type { ProposalRouteServices } from "../../routes/proposals.js";

import { ALAYA_SYSEXITS, type AlayaCliContext } from "../../cli/bridge.js";

import { createReviewCommand } from "../../cli/review.js";

import { callAlayaMcpMemoryTool } from "../../mcp/mcp-server.js";

import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";

import { createInspectorApp } from "../../../../inspector/src/runtime/app.js";

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

describe("proposal review inspector cli parity", () => {

  it("returns the same review response shape through MCP, Inspector HTTP, and CLI", async () => {
    const mcpResult = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createReviewHandler(),
        contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex", sessionId: "review-parity-mcp-session" })
      },
      "soul.review_memory_proposal",
      reviewerArgs
    );
    const mcpOutput = (mcpResult.structuredContent as { readonly output: unknown }).output;

    const daemonApp = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "daemon-request-token"
      },
      routes: {
        proposals: {
          workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws1" })) } as any,
          memoryService: { findByIdScoped: vi.fn(async () => null) } as any,
          proposalService: {
            findByWorkspaceId: vi.fn(async () => []),
            findPending: vi.fn(async () => [])
          } as any,
          mcpMemoryToolHandler: createReviewHandler()
        } as unknown as ProposalRouteServices
      }
    });

    const forwardedInspectorRequests: Array<{
      readonly url: string;
      readonly requestToken: string | null;
      readonly desktop: string | null;
      readonly body: string | null;
    }> = [];
    const inspectorApp = createInspectorApp({
      token: "inspector-token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      env: {
        ALAYA_REQUEST_TOKEN: "daemon-request-token",
        ALAYA_REVIEWER_TOKEN: "review-token",
        ALAYA_REVIEWER_IDENTITY: "user:server-reviewer"
      },
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        forwardedInspectorRequests.push({
          url: String(input),
          requestToken: headers.get("x-request-token"),
          desktop: headers.get("x-alaya-desktop"),
          body: init?.body === undefined ? null : String(init.body)
        });

        return await daemonApp.request(`${url.pathname}${url.search}`, {
          method: init?.method,
          headers,
          body: init?.body
        });
      }
    });
    const inspectorResponse = await inspectorApp.request("/api/proposals/ws1/prop-1/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-alaya-inspector-token": "inspector-token"
      },
      body: JSON.stringify({
        verdict: reviewerArgs.verdict,
        reason: reviewerArgs.reason,
        reviewer_identity: "user:payload-override"
      })
    });
    expect(inspectorResponse.status).toBe(200);
    const inspectorPayload = (await inspectorResponse.json()) as { readonly data: unknown };

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
    expect(inspectorPayload.data).toEqual(mcpOutput);
    expect(cliResult.json).toEqual(mcpOutput);
    expect(forwardedInspectorRequests).toEqual([
      {
        url: "http://daemon.local/workspaces/ws1/proposals/prop-1/review",
        requestToken: "daemon-request-token",
        desktop: "1",
        body: JSON.stringify({
          verdict: reviewerArgs.verdict,
          reason: reviewerArgs.reason,
          reviewer_identity: reviewerArgs.reviewer_identity,
          reviewer_token: reviewerArgs.reviewer_token
        })
      }
    ]);
  });
});
