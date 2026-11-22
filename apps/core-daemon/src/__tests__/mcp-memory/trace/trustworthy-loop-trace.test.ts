import { describe, expect, it, vi } from "vitest";
import {
  ScopeClass,
  MemoryDimension,
  MemoryGovernanceEventType,
  ProposalResolutionState,
  RecallContextEventType,
  SignalEventType,
  type SoulMemorySearchResponse,
  type SoulReportContextUsageResponse,
  type SoulEmitCandidateSignalResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import {
  PRIMARY_MEMORY_ID,
  TRACE_REVIEWER_IDENTITY,
  TRACE_REVIEWER_TOKEN,
  TRACE_SQL,
  PROPOSAL_MEMBERSHIP_SQL,
  assertTraceSqlUsesMembershipOnly,
  createTrustworthyLoopHarness,
  queryRows,
  parsePayload
} from "./trustworthy-loop-trace-fixture.js";

describe("trustworthy-loop-trace", () => {

  it("reconstructs the agent-driven five-event chain with delivery-id membership SQL only", async () => {
    assertTraceSqlUsesMembershipOnly();
    const harness = await createTrustworthyLoopHarness();

    const recall = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
      protocol_version: 1,
      supported_result_kinds: ["memory_entry", "source_evidence"],
      supports_source_evidence: true,
      supports_product_updates: true,
      query: "pnpm workspace commands",
      scope_class: ScopeClass.PROJECT,
      dimension: MemoryDimension.PREFERENCE,
      domain_tags: null,
      max_results: 3
    });
    const objectId = recall.results[0]!.object_id;

    const usage = await harness.callTool<SoulReportContextUsageResponse>("soul.report_context_usage", {
      delivery_id: recall.delivery_id,
      usage_state: "used",
      used_object_ids: [objectId],
      reason: "Trace test consumed recalled memory."
    });
    expect(usage.status).toBe("recorded");

    const signal = await harness.callTool<SoulEmitCandidateSignalResponse>("soul.emit_candidate_signal", {
      signal_kind: "potential_preference",
      object_kind: "memory_entry",
      scope_hint: ScopeClass.PROJECT,
      domain_tags: ["tooling"],
      confidence: 0.95,
      evidence_refs: [objectId],
      raw_payload: { observation: "Use pnpm for workspace commands." },
      source_delivery_ids: [recall.delivery_id]
    });
    expect(signal.status).toBe("emitted");

    const proposal = await harness.callTool<SoulProposeMemoryUpdateResponse>("soul.propose_memory_update", {
      target_object_id: objectId,
      proposed_changes: { content: "Use pnpm and report memory usage." },
      reason: "Trace test proposal.",
      source_delivery_ids: [recall.delivery_id]
    });
    expect(proposal.status).toBe("created");

    harness.useHumanReviewSurface();
    const review = await harness.callTool<SoulReviewMemoryProposalResponse>("soul.review_memory_proposal", {
      proposal_id: proposal.proposal_id,
      verdict: "reject",
      reason: "Trace test rejects synthetic proposal.",
      reviewer_identity: TRACE_REVIEWER_IDENTITY,
      reviewer_token: TRACE_REVIEWER_TOKEN
    });
    expect(review.resolution_state).toBe(ProposalResolutionState.REJECTED);

    const rows = queryRows(harness.database, TRACE_SQL, recall.delivery_id);
    expect(rows.map((row) => row.event_type)).toEqual([
      RecallContextEventType.SOUL_RECALL_DELIVERED,
      RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
      SignalEventType.SOUL_SIGNAL_EMITTED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(rows.map((row) => parsePayload(row).delivery_id).filter(Boolean)).toEqual([
      recall.delivery_id,
      recall.delivery_id
    ]);
    expect(
      rows
        .filter((row) =>
          row.event_type === SignalEventType.SOUL_SIGNAL_EMITTED ||
          row.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED ||
          row.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
        )
        .map((row) => parsePayload(row).source_delivery_ids)
    ).toEqual([[recall.delivery_id], [recall.delivery_id], [recall.delivery_id]]);
  });

  it("links multi-delivery proposal events by array membership through the public request path", async () => {
    const harness = await createTrustworthyLoopHarness();
    const first = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
      protocol_version: 1,
      supported_result_kinds: ["memory_entry", "source_evidence"],
      supports_source_evidence: true,
      supports_product_updates: true,
      query: "first delivery",
      scope_class: ScopeClass.PROJECT,
      dimension: MemoryDimension.PREFERENCE,
      domain_tags: null,
      max_results: 3
    });
    const second = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
      protocol_version: 1,
      supported_result_kinds: ["memory_entry", "source_evidence"],
      supports_source_evidence: true,
      supports_product_updates: true,
      query: "second delivery",
      scope_class: ScopeClass.PROJECT,
      dimension: MemoryDimension.PREFERENCE,
      domain_tags: null,
      max_results: 3
    });
    const sourceDeliveryIds = [first.delivery_id, second.delivery_id] as const;

    const proposal = await harness.callTool<SoulProposeMemoryUpdateResponse>("soul.propose_memory_update", {
      target_object_id: PRIMARY_MEMORY_ID,
      proposed_changes: { content: "Use pnpm from either recalled delivery." },
      reason: "Multi-delivery trace test.",
      source_delivery_ids: sourceDeliveryIds
    });
    harness.useHumanReviewSurface();
    await harness.callTool<SoulReviewMemoryProposalResponse>("soul.review_memory_proposal", {
      proposal_id: proposal.proposal_id,
      verdict: "reject",
      reason: "Trace test rejects synthetic proposal.",
      reviewer_identity: TRACE_REVIEWER_IDENTITY,
      reviewer_token: TRACE_REVIEWER_TOKEN
    });

    for (const deliveryId of sourceDeliveryIds) {
      const rows = queryRows(harness.database, PROPOSAL_MEMBERSHIP_SQL, deliveryId);
      expect(rows.map((row) => row.event_type)).toEqual([
        MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
        MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
      ]);
      expect(rows.map((row) => parsePayload(row).source_delivery_ids)).toEqual([
        sourceDeliveryIds,
        sourceDeliveryIds
      ]);
    }
  });

  it("keeps Garden-originated signals unanchored and does not warn for GARDEN_COMPILE", async () => {
    const warn = vi.fn();
    const harness = await createTrustworthyLoopHarness({ warn });
    const sessionTaskId = await harness.captureClosedSession();

    const claimed = await harness.callTool<{ payload: { source_statements: {
      requests: readonly import("@do-soul/alaya-protocol").SourceStatementRequest[] } } }>(
      "garden.claim_task", { task_id: sessionTaskId });
    await harness.callTool("garden.complete_task", {
      task_id: sessionTaskId,
      status: "completed",
      result_envelope: {
        source_statement_responses: claimed.payload.source_statements.requests.map(request => ({
          chunk_index: request.chunk_index,
          raw_json: JSON.stringify({ messages: request.messages.map((message, index) => ({
            message_id: message.message_id,
            statements: index === 0 ? [{ text: message.text, relation: "recorded observation" }] : []
          })) })
        }))
      }
    });

    const gardenSignals = (await harness.eventLogRepo.queryByType(SignalEventType.SOUL_SIGNAL_EMITTED))
      .events
      .filter((entry) => (entry.payload_json as { source?: unknown }).source === "garden_compile");
    expect(gardenSignals.length).toBeGreaterThanOrEqual(1);
    for (const signal of gardenSignals) {
      expect(signal.payload_json).not.toHaveProperty("source_delivery_ids");
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
