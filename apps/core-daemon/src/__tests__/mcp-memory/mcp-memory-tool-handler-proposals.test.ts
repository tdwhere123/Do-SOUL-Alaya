import { describe, expect, it, vi } from "vitest";
import { ProposalResolutionState } from "@do-soul/alaya-protocol";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";
import {
  context,
  createDeliveryRecord,
  createDeps
} from "./mcp-memory-tool-handler-fixture.js";

describe("mcp memory tool handler", () => {
  it("fails closed for unsupported tools and invalid input", async () => {
    const handler = createMcpMemoryToolHandler(createDeps());

    await expect(
      handler.call({ toolName: "memory.recall", arguments: {}, context })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL" }
    });

    await expect(
      handler.call({ toolName: "soul.recall", arguments: { query: "" }, context })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
  });

  it("fails closed when proposal workflow is unavailable", async () => {
    const handler = createMcpMemoryToolHandler(createDeps());

    const result = await handler.call({
      toolName: "soul.propose_memory_update",
      arguments: {
        target_object_id: "mem1",
        proposed_changes: { content: "next" },
        reason: "user correction"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  it("rejects forged source delivery anchors before proposal workflow receives proposals", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () => null);
    const proposalWorkflow: NonNullable<McpMemoryToolHandlerDependencies["proposalWorkflow"]> = {
      proposeMemoryUpdate: vi.fn(async () => ({
        proposal_id: "proposal-1",
        status: "created" as const
      })),
      reviewMemoryProposal: vi.fn(async () => ({
        proposal_id: "proposal-1",
        resolution_state: ProposalResolutionState.ACCEPTED
      })),
      listPendingProposals: vi.fn(async () => ({
        proposals: [],
        total_count: 0
      }))
    };
    const handler = createMcpMemoryToolHandler({ ...deps, proposalWorkflow });

    const result = await handler.call({
      toolName: "soul.propose_memory_update",
      arguments: {
        target_object_id: "mem1",
        proposed_changes: { content: "forged" },
        reason: "spoofed anchor",
        source_delivery_ids: ["delivery-forged"]
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(proposalWorkflow.proposeMemoryUpdate).not.toHaveBeenCalled();
  });

  it("threads source delivery anchors through emit_candidate_signal and warns when MODEL_TOOL omits them", async () => {
    const warn = vi.fn();
    const deps = { ...createDeps(), warn };
    deps.trustStateRecorder.findDeliveryById = vi.fn(async (deliveryId: string) =>
      createDeliveryRecord(deliveryId)
    );
    const handler = createMcpMemoryToolHandler(deps);

    await expect(
      handler.call({
        toolName: "soul.emit_candidate_signal",
        arguments: {
          signal_kind: "potential_preference",
          object_kind: "memory_entry",
          scope_hint: "project",
          domain_tags: ["tooling"],
          confidence: 0.9,
          evidence_refs: ["memory-1"],
          raw_payload: { observation: "Use pnpm." },
          source_delivery_ids: ["delivery-1", "delivery-2"]
        },
        context
      })
    ).resolves.toMatchObject({ ok: true });

    expect(deps.signalService.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "model_tool",
        source_delivery_ids: ["delivery-1", "delivery-2"]
      })
    );
    expect(warn).not.toHaveBeenCalled();

    await expect(
      handler.call({
        toolName: "soul.emit_candidate_signal",
        arguments: {
          signal_kind: "potential_preference",
          object_kind: "memory_entry",
          scope_hint: "project",
          domain_tags: ["tooling"],
          confidence: 0.9,
          evidence_refs: ["memory-1"],
          raw_payload: { observation: "Missing anchor." }
        },
        context
      })
    ).resolves.toMatchObject({ ok: true });

    expect(warn).toHaveBeenCalledWith(
      "MODEL_TOOL candidate signal emitted without source_delivery_ids.",
      expect.objectContaining({
        source: "model_tool"
      })
    );
  });

  // invariant: graph-edge ref hints in raw_payload are NOT promoted to
  // first-class signal fields. The 5 ref keys are first-class on
  // `CandidateMemorySignal`; raw_payload occurrences are logged and
  // left in raw_payload unchanged (warn-and-keep).
  it("ignores raw_payload graph-edge ref keys and warns; first-class fields are the only entry", async () => {
    const warn = vi.fn();
    const deps = { ...createDeps(), warn };
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.emit_candidate_signal",
      arguments: {
        signal_kind: "potential_preference",
        object_kind: "memory_entry",
        scope_hint: "project",
        domain_tags: ["tooling"],
        confidence: 0.9,
        evidence_refs: ["memory-1"],
        raw_payload: {
          observation: "Use pnpm.",
          source_memory_refs: ["memory-parent"],
          contradicts_refs: ["memory-conflict"]
        }
      },
      context
    });

    expect(result).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("raw_payload contains graph-edge ref keys"),
      expect.objectContaining({
        offending_keys: expect.arrayContaining(["source_memory_refs", "contradicts_refs"])
      })
    );
    expect(deps.signalService.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        // first-class fields default to [] because the request did not
        // supply them; raw_payload entries do NOT promote.
        source_memory_refs: [],
        contradicts_refs: [],
        raw_payload: {
          observation: "Use pnpm.",
          source_memory_refs: ["memory-parent"],
          contradicts_refs: ["memory-conflict"]
        }
      })
    );
  });

  // invariant: warn-and-keep regression for all 5 graph-ref keys at once.
  // The normalizer never PROMOTES raw_payload ref keys to first-class
  // fields (silent double-entry was the audit risk), but it must also
  // leave raw_payload UNCHANGED — downstream subscribers may still want
  // to read the raw envelope for diagnostics. The single warn must list
  // every offending key so an operator gets one event per signal, not
  // one per key. see also: apps/core-daemon/src/mcp-memory/tool-handler.ts
  // normalizeCandidateSignalGraphRefs.
  it("warn-and-keep: all 5 raw_payload ref keys are preserved + reported in one warn", async () => {
    const warn = vi.fn();
    const deps = { ...createDeps(), warn };
    const handler = createMcpMemoryToolHandler(deps);

    const rawPayloadWithAllFiveKeys = {
      observation: "Use pnpm.",
      source_memory_refs: ["memory-source"],
      supersedes_refs: ["memory-superseded"],
      exception_to_refs: ["memory-exception"],
      contradicts_refs: ["memory-conflict"],
      incompatible_with_refs: ["memory-incompat"]
    };
    const result = await handler.call({
      toolName: "soul.emit_candidate_signal",
      arguments: {
        signal_kind: "potential_preference",
        object_kind: "memory_entry",
        scope_hint: "project",
        domain_tags: ["tooling"],
        confidence: 0.9,
        evidence_refs: ["memory-1"],
        raw_payload: rawPayloadWithAllFiveKeys
      },
      context
    });

    expect(result).toMatchObject({ ok: true });

    // One warn fires per signal, listing every offending key.
    const refKeyWarnCalls = warn.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("raw_payload contains graph-edge ref keys")
    );
    expect(refKeyWarnCalls).toHaveLength(1);
    const offendingKeys = (refKeyWarnCalls[0]![1] as { offending_keys: readonly string[] })
      .offending_keys;
    expect(new Set(offendingKeys)).toEqual(
      new Set([
        "source_memory_refs",
        "supersedes_refs",
        "exception_to_refs",
        "contradicts_refs",
        "incompatible_with_refs"
      ])
    );

    // First-class fields stay empty (NOT promoted from raw_payload), and
    // raw_payload itself is forwarded verbatim — the keep half of the
    // warn-and-keep contract.
    expect(deps.signalService.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        source_memory_refs: [],
        supersedes_refs: [],
        exception_to_refs: [],
        contradicts_refs: [],
        incompatible_with_refs: [],
        raw_payload: rawPayloadWithAllFiveKeys
      })
    );
  });

  // First-class ref fields supplied via the request body still flow
  // through. raw_payload remains a free-form bag with no ref-key magic.
  it("accepts first-class graph-edge ref fields on emit_candidate_signal", async () => {
    const warn = vi.fn();
    const deps = { ...createDeps(), warn };
    deps.trustStateRecorder.findDeliveryById = vi.fn(async (deliveryId: string) =>
      createDeliveryRecord(deliveryId)
    );
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.emit_candidate_signal",
      arguments: {
        signal_kind: "potential_preference",
        object_kind: "memory_entry",
        scope_hint: "project",
        domain_tags: ["tooling"],
        confidence: 0.9,
        evidence_refs: ["memory-1"],
        source_memory_refs: ["memory-parent"],
        contradicts_refs: ["memory-conflict"],
        raw_payload: { observation: "Use pnpm." },
        source_delivery_ids: ["delivery-1"]
      },
      context
    });

    expect(result).toMatchObject({ ok: true });
    // raw_payload contained no ref keys; the graph-ref normalizer must
    // not emit a warning. Other unrelated warn paths are checked
    // separately above (missing source_delivery_ids).
    const refKeyWarnCalls = warn.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("raw_payload contains graph-edge ref keys")
    );
    expect(refKeyWarnCalls).toEqual([]);
    expect(deps.signalService.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        source_memory_refs: ["memory-parent"],
        contradicts_refs: ["memory-conflict"],
        raw_payload: { observation: "Use pnpm." }
      })
    );
  });

  it("rejects source delivery anchors that are not recorded in the trusted context table", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () => null);
    const handler = createMcpMemoryToolHandler(deps);

    await expect(
      handler.call({
        toolName: "soul.emit_candidate_signal",
        arguments: {
          signal_kind: "potential_preference",
          object_kind: "memory_entry",
          scope_hint: "project",
          domain_tags: ["tooling"],
          confidence: 0.9,
          evidence_refs: ["memory-1"],
          raw_payload: { observation: "Forged anchor." },
          source_delivery_ids: ["delivery-forged"]
        },
        context
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(deps.signalService.receiveSignal).not.toHaveBeenCalled();
  });

  it("dispatches soul.propose_edge through the workspace-scoped edge proposal service", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.propose_edge",
      arguments: {
        source_memory_id: "mem1",
        target_memory_id: "mem2",
        edge_type: "recalls",
        confidence: 0.7,
        reason: "operator reviewed relationship"
      },
      context
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        proposal_id: "edge-proposal-1",
        status: "pending"
      }
    });
    expect(deps.edgeProposalService?.proposeExplicitEdge).toHaveBeenCalledWith({
      sourceMemoryId: "mem1",
      targetMemoryId: "mem2",
      edgeType: "recalls",
      confidence: 0.5,
      reason: "operator reviewed relationship",
      workspaceId: "ws1",
      runId: "run1"
    });
  });

  it("dispatches soul.list_pending_edge_proposals through trusted workspace scope", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.list_pending_edge_proposals",
      arguments: {
        edge_type: "recalls",
        min_confidence: 0.5
      },
      context
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        total_count: 1,
        proposals: [
          expect.objectContaining({
            proposal_id: "edge-proposal-1",
            edge_type: "recalls"
          })
        ]
      }
    });
    expect(deps.edgeProposalService?.listPending).toHaveBeenCalledWith("ws1", {
      edge_type: "recalls",
      min_confidence: 0.5
    });
  });

  it("dispatches soul.batch_review_edge_proposals for explicit review", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);
    const reviewContext = { ...context, agentTarget: "cli" };

    const result = await handler.call({
      toolName: "soul.batch_review_edge_proposals",
      arguments: {
        verdict: "accept",
        filter: {
          proposal_ids: ["edge-proposal-1"]
        },
        reason: "accepted in batch",
        reviewer_identity: "user:reviewer"
      },
      context: reviewContext
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        accepted_count: 1,
        rejected_count: 0,
        reviewed_proposal_ids: ["edge-proposal-1"]
      }
    });
    expect(deps.edgeProposalService?.batchReview).toHaveBeenCalledWith({
      workspaceId: "ws1",
      verdict: "accept",
      filter: { proposal_ids: ["edge-proposal-1"] },
      reason: "accepted in batch",
      reviewerIdentity: "user:reviewer"
    });
  });

  it("requires reviewer token binding for edge proposal review from an attached agent", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler({
      ...deps,
      reviewerIdentityBinding: {
        token: "review-token",
        identity: "user:server-reviewer"
      }
    });

    const missingToken = await handler.call({
      toolName: "soul.batch_review_edge_proposals",
      arguments: {
        verdict: "accept",
        filter: { proposal_ids: ["edge-proposal-1"] },
        reason: "missing token",
        reviewer_identity: "user:server-reviewer"
      },
      context
    });
    expect(missingToken).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: "Invalid reviewer token." }
    });

    const payloadSpoof = await handler.call({
      toolName: "soul.batch_review_edge_proposals",
      arguments: {
        verdict: "accept",
        filter: { proposal_ids: ["edge-proposal-1"] },
        reason: "payload spoof",
        reviewer_identity: "user:payload",
        reviewer_token: "review-token"
      },
      context
    });
    expect(payloadSpoof).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Reviewer identity does not match server-bound reviewer."
      }
    });

    const accepted = await handler.call({
      toolName: "soul.batch_review_edge_proposals",
      arguments: {
        verdict: "accept",
        filter: { proposal_ids: ["edge-proposal-1"] },
        reason: "server-bound reviewer",
        reviewer_identity: "user:server-reviewer",
        reviewer_token: "review-token"
      },
      context
    });
    expect(accepted.ok).toBe(true);
    expect(deps.edgeProposalService?.batchReview).toHaveBeenCalledWith(expect.objectContaining({
      reviewerIdentity: "user:server-reviewer"
    }));
  });
});
