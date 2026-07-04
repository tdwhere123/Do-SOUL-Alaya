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

import type { ProposalRouteServices } from "../../routes/governance/proposals.js";

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

describe("proposal review error parity", () => {

  it("returns identical NOT_FOUND envelope across MCP, Inspector HTTP, and CLI when proposal_id is unknown", async () => {
    const { mcp, inspector, cli } = await runReviewParityScenario(() =>
      createErrorReviewHandler({ kind: "proposal_not_found" })
    );

    expect(mcp.ok).toBe(false);
    expect(mcp.error.code).toBe("NOT_FOUND");
    const expectedMessage = "Proposal not found: prop-1";
    expect(mcp.error.message).toBe(expectedMessage);

    expect(inspector.body.error?.code).toBe(mcp.error.code);
    expect(inspector.body.error?.message).toBe(mcp.error.message);
    expect([404, 400]).toContain(inspector.status);

    expect(cli.exitCode).not.toBe(ALAYA_SYSEXITS.OK);
    expect(cli.stderr).toContain("NOT_FOUND");
    expect(cli.stderr).toContain(expectedMessage);
  });
});
