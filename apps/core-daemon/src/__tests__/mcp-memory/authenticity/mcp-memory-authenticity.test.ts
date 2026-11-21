import { describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
  GovernanceResolutionEventType,
  MemoryDimension,
  MemoryGovernanceEventType,
  ProposalResolutionState,
  RecallContextEventType,
  ScopeClass,
  parseGovernanceResolutionEventPayload,
  parseMemoryGovernanceEventPayload,
  parseRecallContextEventPayload,
  type SoulMemorySearchResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReportContextUsageResponse,
  type SoulResolveResponse
} from "@do-soul/alaya-protocol";
import {
  AUTHENTICITY_EVIDENCE_ID,
  DRAFT_CLAIM_ID,
  PRIMARY_MEMORY_ID,
  PROPOSED_CONTENT,
  TEST_TIMEOUT_MS,
  createAuthenticityHarness,
  createDraftClaim,
  createMemoryEntry,
  seedRecallMemory,
  withEvidenceRepos
} from "./mcp-memory-authenticity-fixture.js";

describe("MCP memory authenticity proof", () => {

  it("records recall deliveries and usage through the real daemon runtime", async () => {
    const harness = await createAuthenticityHarness();

    try {
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
      expect(recall.results.map((result) => result.object_id)).toContain(PRIMARY_MEMORY_ID);

      const usage = await harness.callTool<SoulReportContextUsageResponse>(
        "soul.report_context_usage",
        {
          delivery_id: recall.delivery_id,
          usage_state: "used",
          used_object_ids: [PRIMARY_MEMORY_ID],
          reason: "Authenticity proof consumed recalled memory."
        }
      );
      expect(usage).toEqual({ delivery_id: recall.delivery_id, status: "recorded" });

      const evidence = await withEvidenceRepos(harness.dataDir, async (repos) => {
        const [delivery, usages, deliveredEvents, usageEvents] = await Promise.all([
          repos.trustStateRepo.findDeliveryById(recall.delivery_id),
          repos.trustStateRepo.listUsageByDeliveryIds([recall.delivery_id]),
          repos.eventLogRepo.queryByType(RecallContextEventType.SOUL_RECALL_DELIVERED)
            .then((page) => page.events),
          repos.eventLogRepo.queryByType(RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED)
            .then((page) => page.events)
        ]);
        return { delivery, usages, deliveredEvents, usageEvents };
      });

      expect(evidence.delivery).toMatchObject({
        delivery_id: recall.delivery_id,
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: [PRIMARY_MEMORY_ID]
      });
      expect(evidence.usages).toEqual([
        expect.objectContaining({
          delivery_id: recall.delivery_id,
          usage_state: "used",
          used_object_ids: [PRIMARY_MEMORY_ID]
        })
      ]);

      const deliveredEvent = evidence.deliveredEvents.find((entry) => {
        const payload = parseRecallContextEventPayload(
          RecallContextEventType.SOUL_RECALL_DELIVERED,
          entry.payload_json as Record<string, unknown>
        );
        return payload.delivery_id === recall.delivery_id;
      });
      expect(deliveredEvent).toBeDefined();
      expect(
        parseRecallContextEventPayload(
          RecallContextEventType.SOUL_RECALL_DELIVERED,
          deliveredEvent!.payload_json as Record<string, unknown>
        )
      ).toMatchObject({
        delivery_id: recall.delivery_id,
        workspace_id: "workspace-1",
        agent_target: "codex",
        pointer_count: 1
      });

      const usageEvent = evidence.usageEvents.find((entry) => {
        const payload = parseRecallContextEventPayload(
          RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
          entry.payload_json as Record<string, unknown>
        );
        return payload.delivery_id === recall.delivery_id;
      });
      expect(usageEvent).toBeDefined();
      expect(
        parseRecallContextEventPayload(
          RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
          usageEvent!.payload_json as Record<string, unknown>
        )
      ).toMatchObject({
        delivery_id: recall.delivery_id,
        usage_state: "used",
        workspace_id: "workspace-1"
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it("delivers every planted gold through soul.recall on a real RecallService", async () => {
    const golds = [
      {
        object_id: "00000000-0000-4000-8000-0000000000c1",
        evidence_id: "11111111-1111-4111-8111-1111111111c1",
        content: "Office wifi passphrase is ZebraQuiltNine.",
        factorValue: "ZebraQuiltNine"
      },
      {
        object_id: "00000000-0000-4000-8000-0000000000c2",
        evidence_id: "11111111-1111-4111-8111-1111111111c2",
        content: "Backup vault unlock PIN is 448291.",
        factorValue: "448291"
      },
      {
        object_id: "00000000-0000-4000-8000-0000000000c3",
        evidence_id: "11111111-1111-4111-8111-1111111111c3",
        content: "On-call rotation starter is Mina Voss.",
        factorValue: "Mina Voss"
      }
    ] as const;
    const decoys = [
      {
        object_id: "00000000-0000-4000-8000-0000000000d0",
        content: "Unrelated kettle descaling interval note 0."
      },
      {
        object_id: "00000000-0000-4000-8000-0000000000d1",
        content: "Unrelated kettle descaling interval note 1."
      },
      {
        object_id: "00000000-0000-4000-8000-0000000000d2",
        content: "Unrelated kettle descaling interval note 2."
      },
      {
        object_id: "00000000-0000-4000-8000-0000000000d3",
        content: "Unrelated kettle descaling interval note 3."
      }
    ] as const;

    const harness = await createAuthenticityHarness(async (repos, database) => {
      for (const gold of golds) {
        const memory = createMemoryEntry({
          object_id: gold.object_id,
          evidence_refs: [gold.evidence_id],
          content: gold.content,
          dimension: MemoryDimension.FACT,
          activation_score: 0.2
        });
        await seedRecallMemory({ database, memory: memory });
      }
      for (const decoy of decoys) {
        await seedRecallMemory({ database, memory: createMemoryEntry({
          object_id: decoy.object_id,
          evidence_refs: [],
          content: decoy.content,
          dimension: MemoryDimension.FACT,
          activation_score: 0.95
        }) });
      }
    });

    try {
      const recall = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
        protocol_version: 1,
        supported_result_kinds: ["memory_entry", "source_evidence"],
        supports_source_evidence: true,
        supports_product_updates: true,
        query: "ZebraQuiltNine wifi passphrase, 448291 vault unlock PIN, and on-call rotation starter Mina Voss",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 5
      });
      const deliveredIds = recall.results.map((result) => result.object_id);
      const goldDelivered = golds.every((gold) => recall.results.some((row) =>
        row.object_id === gold.object_id
        || (row.content_preview ?? "").includes(gold.factorValue)));
      const decoyIds = decoys.map((decoy) => decoy.object_id);
      expect(goldDelivered).toBe(true);
      expect(decoyIds.some((id) => !deliveredIds.includes(id))).toBe(true);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it("creates proposal rows and proposal-created audit events through the real MCP path", async () => {
    const harness = await createAuthenticityHarness();

    try {
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

      const proposal = await harness.callTool<SoulProposeMemoryUpdateResponse>(
        "soul.propose_memory_update",
        {
          target_object_id: PRIMARY_MEMORY_ID,
          proposed_changes: { content: PROPOSED_CONTENT },
          reason: "Authenticity proof proposal.",
          source_delivery_ids: [recall.delivery_id]
        }
      );
      expect(proposal.status).toBe("created");

      const evidence = await withEvidenceRepos(harness.dataDir, async (repos) => {
        const [scopedProposal, events] = await Promise.all([
          repos.proposalRepo.findScopedById(proposal.proposal_id),
          repos.eventLogRepo.queryByEntity("proposal", proposal.proposal_id)
        ]);
        return { scopedProposal, events };
      });

      expect(evidence.scopedProposal).toMatchObject({
        proposal: {
          proposal_id: proposal.proposal_id,
          resolution_state: ProposalResolutionState.PENDING
        },
        target_object_kind: "memory_entry",
        proposed_changes: { content: PROPOSED_CONTENT },
        source_delivery_ids: [recall.delivery_id]
      });

      const createdEvent = evidence.events.find(
        (entry) => entry.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED
      );
      expect(createdEvent).toBeDefined();
      expect(
        parseMemoryGovernanceEventPayload(
          MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
          createdEvent!.payload_json as Record<string, unknown>
        )
      ).toMatchObject({
        object_id: proposal.proposal_id,
        object_kind: "proposal",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source_delivery_ids: [recall.delivery_id]
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it("activates a draft claim through soul.resolve.confirm and writes durable audit rows", async () => {
    const harness = await createAuthenticityHarness(async (repos) => {
      repos.claimFormRepo.create(createDraftClaim());
    });

    try {
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
      expect(recall.results.map((result) => result.object_id)).toContain(PRIMARY_MEMORY_ID);

      const resolution = await harness.callTool<SoulResolveResponse>("soul.resolve", {
        target_object_id: DRAFT_CLAIM_ID,
        resolution: "confirm",
        delivery_id: recall.delivery_id,
        policy: "conflict_detection.v1",
        reason: "Authenticity proof confirms the staged draft claim.",
        reviewer_identity: "user:lane-f-authenticity",
        reviewer_token: "lane-f-authenticity-token"
      });
      expect(resolution).toMatchObject({
        target_object_id: DRAFT_CLAIM_ID,
        resolution: "confirm",
        status: "applied",
        audit_event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED,
        activated_claim_id: DRAFT_CLAIM_ID
      });

      const evidence = await withEvidenceRepos(harness.dataDir, async (repos) => {
        const [claim, resolutionEvents, claimLifecycleEvents] = await Promise.all([
          repos.claimFormRepo.findById(DRAFT_CLAIM_ID),
          repos.eventLogRepo.queryByEntity("soul_resolution", DRAFT_CLAIM_ID),
          repos.eventLogRepo.queryByEntity("claim_form", DRAFT_CLAIM_ID)
        ]);
        return { claim, resolutionEvents, claimLifecycleEvents };
      });

      expect(evidence.claim).toMatchObject({
        object_id: DRAFT_CLAIM_ID,
        claim_status: ClaimLifecycleState.ACTIVE
      });

      const confirmEvent = evidence.resolutionEvents.find(
        (entry) => entry.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
      );
      expect(confirmEvent).toBeDefined();
      expect(
        parseGovernanceResolutionEventPayload(
          GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED,
          confirmEvent!.payload_json as Record<string, unknown>
        )
      ).toMatchObject({
        target_object_id: DRAFT_CLAIM_ID,
        resolution: "confirm",
        delivery_id: recall.delivery_id,
        agent_target: "codex",
        activated_claim_id: DRAFT_CLAIM_ID
      });

      expect(
        evidence.claimLifecycleEvents.some(
          (entry) => entry.event_type === MemoryGovernanceEventType.SOUL_CLAIM_LIFECYCLE_CHANGED
        )
      ).toBe(true);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
