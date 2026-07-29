import { describe, expect, it } from "vitest";
import { ProposalResolutionState } from "@do-soul/alaya-protocol";
import {
  assertReviewCallerIsAllowed,
  createWorkflowError
} from "../../../mcp-memory/proposal/proposal-workflow-reviewer.js";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import type { McpMemoryToolCallContext } from "../../../mcp-memory/tool/tool-handler.js";
import { context } from "../tool/mcp-memory-tool-handler-fixture.js";
import {
  createReviewHandler,
  reviewerArgs
} from "./proposal-review-parity-fixture.js";

const reviewerBinding = {
  token: "review-token",
  identity: "user:server-reviewer"
} as const;

function createReviewContext(agentTarget: string): McpMemoryToolCallContext {
  return { ...context, agentTarget, runId: null };
}

describe("assertReviewCallerIsAllowed", () => {
  it("rejects attached agents even when reviewer binding is configured and token matches", () => {
    expect(() =>
      assertReviewCallerIsAllowed(createReviewContext("codex"), reviewerBinding)
    ).toThrowError(
      createWorkflowError(
        "VALIDATION",
        "Review requires a human reviewer surface (Inspector/alaya review); attached agents cannot review."
      )
    );
  });

  it("allows Inspector when reviewer binding is configured", () => {
    expect(() =>
      assertReviewCallerIsAllowed(createReviewContext("inspector"), reviewerBinding)
    ).not.toThrow();
  });

  it("allows CLI when reviewer binding is configured", () => {
    expect(() =>
      assertReviewCallerIsAllowed(createReviewContext("cli"), reviewerBinding)
    ).not.toThrow();
  });
});

describe("proposal review caller authorization", () => {
  it("rejects attached-agent review with a valid reviewer token when binding is configured", async () => {
    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createReviewHandler(),
        contextProvider: () => createReviewContext("codex")
      },
      "soul.review_memory_proposal",
      reviewerArgs
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Review requires a human reviewer surface (Inspector/alaya review); attached agents cannot review."
      }
    });
  });

  it("allows Inspector review with a valid reviewer token when binding is configured", async () => {
    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createReviewHandler(),
        contextProvider: () => createReviewContext("inspector")
      },
      "soul.review_memory_proposal",
      reviewerArgs
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      output: {
        proposal_id: "prop-1",
        resolution_state: ProposalResolutionState.ACCEPTED
      }
    });
  });

  it("still rejects invalid reviewer tokens on human reviewer surfaces", async () => {
    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createReviewHandler(),
        contextProvider: () => createReviewContext("inspector")
      },
      "soul.review_memory_proposal",
      {
        ...reviewerArgs,
        reviewer_token: "wrong-token"
      }
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: "Invalid reviewer token." }
    });
  });
});
