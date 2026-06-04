import { describe, expect, it } from "vitest";
import {
  MemoryGovernanceEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy,
  type EventLogEntry,
  type Proposal,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { createMcpMemoryProposalWorkflow } from "../mcp-memory-proposal-workflow.js";

// invariant: the librarian/auditor synthesis review proposal accept path.
// Accepting must CREATE a SynthesisCapsule (MEMORY-COMPRESSION entry), not throw
// NOT_FOUND. The capsule's summary is a deterministic, NO-LLM distillation of the
// member evidence gists, so two runs over identical input produce identical
// summaries. Rejecting creates no capsule.
// see also: ../mcp-memory-proposal-workflow.ts prepareAcceptedSynthesisCreate

function createSynthesisProposal(dossierRef: string, droppedCandidates: readonly string[]): Proposal {
  return {
    runtime_id: "00000000-0000-4000-8000-0000000000aa",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: dossierRef === "librarian.synthesis"
      ? "synthesis-subject:tooling/package-manager"
      : "bootstrapping:tooling-pattern",
    retention_policy: RetentionPolicy.RUN_SCOPED,
    proposal_id: "00000000-0000-4000-8000-0000000000aa",
    dossier_ref: dossierRef,
    recommended_option_id: "00000000-0000-4000-8000-0000000000bb",
    proposal_options: [
      {
        option_id: "00000000-0000-4000-8000-0000000000bb",
        option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
        preserves_protected_constraints: true,
        dropped_candidates: [...droppedCandidates],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: "2026-04-30T00:00:00.000Z"
  };
}

interface Harness {
  readonly workflow: ReturnType<typeof createMcpMemoryProposalWorkflow>;
  readonly events: EventLogEntry[];
  readonly order: string[];
  readonly capsules: SynthesisCapsule[];
  readonly proposals: Map<string, { proposal: Proposal; workspace_id: string; run_id: string | null }>;
}

function createHarness(options: {
  readonly proposal: Proposal;
  readonly gistsByEvidence: Readonly<Record<string, string | null>>;
  // The member object_ids the resolver returns for the capsule's evidence_refs.
  // Defaults to none (the resolver-unwired posture: empty source_memory_refs).
  readonly memberObjectIdsByEvidence?: Readonly<Record<string, readonly string[]>>;
}): Harness {
  const events: EventLogEntry[] = [];
  const order: string[] = [];
  const capsules: SynthesisCapsule[] = [];
  const proposals = new Map<
    string,
    { proposal: Proposal; workspace_id: string; run_id: string | null }
  >();
  proposals.set(options.proposal.proposal_id, {
    proposal: options.proposal,
    workspace_id: "ws1",
    run_id: null
  });
  let eventCounter = 0;

  const storeEvents = (resolutionEvents: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[]) =>
    resolutionEvents.map((event) => {
      order.push(`event:${event.event_type}`);
      const entry = {
        event_id: `event-${++eventCounter}`,
        created_at: "2026-04-30T00:00:00.000Z",
        revision: 0,
        ...event
      } satisfies EventLogEntry;
      events.push(entry);
      return entry;
    });

  const workflow = createMcpMemoryProposalWorkflow({
    now: () => "2026-04-30T00:00:00.000Z",
    generateObjectId: () => "00000000-0000-4000-8000-0000000000cc",
    eventLogRepo: {
      append: async (input) => {
        const entry = {
          event_id: `event-${++eventCounter}`,
          created_at: "2026-04-30T00:00:00.000Z",
          revision: 0,
          ...input
        } satisfies EventLogEntry;
        events.push(entry);
        return entry;
      },
      queryByEntity: async (entityType, entityId) =>
        events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
    },
    proposalRepo: {
      create: async ({ proposal }) => proposal,
      createProposalWithEvents: async ({ proposal }, creationEvents) => ({
        proposal,
        events: storeEvents(creationEvents)
      }),
      findById: async (proposalId) => proposals.get(proposalId)?.proposal ?? null,
      findScopedById: async (proposalId) => proposals.get(proposalId) ?? null,
      findPendingSummaries: async () => [],
      acceptPendingSynthesisCreateWithEvents: async (proposalId, updatedAt, resolutionEvents, synthesisCreate) => {
        order.push("repo:acceptPendingSynthesisCreateWithEvents");
        const existing = proposals.get(proposalId);
        if (existing === undefined) {
          throw new Error("missing proposal");
        }
        const storedEvents = storeEvents(resolutionEvents);
        // The atomic storage method appends SOUL_SYNTHESIS_CREATED itself; the
        // fake records the capsule insert + that event so the test can assert the
        // capsule landed and the event followed the resolve events.
        capsules.push(synthesisCreate.capsule);
        const synthesisEvent = storeEvents([
          {
            event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
            entity_type: "synthesis_capsule",
            entity_id: synthesisCreate.capsule.object_id,
            workspace_id: synthesisCreate.capsule.workspace_id,
            run_id: synthesisCreate.capsule.run_id,
            caused_by: synthesisCreate.capsule.created_by,
            payload_json: {
              object_id: synthesisCreate.capsule.object_id,
              object_kind: synthesisCreate.capsule.object_kind,
              workspace_id: synthesisCreate.capsule.workspace_id,
              run_id: synthesisCreate.capsule.run_id
            }
          }
        ])[0]!;
        const updated = {
          ...existing.proposal,
          resolution_state: ProposalResolutionState.ACCEPTED,
          last_updated_at: updatedAt
        } satisfies Proposal;
        proposals.set(proposalId, { ...existing, proposal: updated });
        return { proposal: updated, events: [...storedEvents, synthesisEvent] };
      },
      updatePendingResolutionWithEvents: async (proposalId, state, updatedAt, resolutionEvents) => {
        order.push("repo:updatePendingResolutionWithEvents");
        const existing = proposals.get(proposalId);
        if (existing === undefined) {
          throw new Error("missing proposal");
        }
        const storedEvents = storeEvents(resolutionEvents);
        const updated = {
          ...existing.proposal,
          resolution_state: state,
          last_updated_at: updatedAt
        } satisfies Proposal;
        proposals.set(proposalId, { ...existing, proposal: updated });
        return { proposal: updated, events: storedEvents };
      }
    },
    runtimeNotifier: {
      notifyEntry: async (entry) => {
        order.push(`notify:${entry.event_type}`);
      }
    },
    synthesisEvidenceReader: {
      findGistById: async (evidenceId) => options.gistsByEvidence[evidenceId] ?? null
    },
    synthesisMemberResolver: {
      // Mirrors memoryEntryRepo.findByEvidenceRefs: returns the member object_ids
      // for every memory whose evidence_refs intersect the queried evidence set.
      findMemberObjectIdsByEvidenceRefs: async (_workspaceId, evidenceRefs) => {
        const map = options.memberObjectIdsByEvidence ?? {};
        const members = new Set<string>();
        for (const evidenceRef of evidenceRefs) {
          for (const memberId of map[evidenceRef] ?? []) {
            members.add(memberId);
          }
        }
        return [...members];
      }
    }
  });

  return { workflow, events, order, capsules, proposals };
}

describe("mcp synthesis create accept", () => {
  it("creates a synthesis capsule when a librarian synthesis proposal is accepted", async () => {
    const proposal = createSynthesisProposal("librarian.synthesis", ["ev-1", "ev-2"]);
    const harness = createHarness({
      proposal,
      gistsByEvidence: {
        "ev-1": "prefer pnpm for workspace commands",
        "ev-2": "npm is deprecated for this repo"
      },
      // ev-1 backs member mem-a; ev-2 backs members mem-a (again) + mem-b. The
      // resolved member set is de-duplicated and sorted deterministically.
      memberObjectIdsByEvidence: {
        "ev-1": ["mem-a"],
        "ev-2": ["mem-a", "mem-b"]
      }
    });

    const reviewed = await harness.workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "confirmed",
        reviewer_identity: "user:reviewer-1"
      },
      { workspaceId: "ws1", runId: null, agentTarget: "cli", sessionId: "session-1" }
    );

    expect(reviewed).toEqual({
      proposal_id: proposal.proposal_id,
      resolution_state: ProposalResolutionState.ACCEPTED
    });
    expect(harness.capsules).toHaveLength(1);
    const capsule = harness.capsules[0]!;
    expect(capsule.topic_key).toBe("tooling/package-manager");
    expect(capsule.synthesis_type).toBe("cross_evidence");
    expect(capsule.evidence_refs).toEqual(["ev-1", "ev-2"]);
    // invariant: source_memory_refs is populated with the cluster's member
    // memories (resolved via evidence-ref intersection), de-duplicated + sorted —
    // this is what arms the autonomous compress disposition for each member.
    expect(capsule.source_memory_refs).toEqual(["mem-a", "mem-b"]);
    expect(capsule.workspace_id).toBe("ws1");
    expect(capsule.run_id).toBe("synthesis-accept:ws1");
    expect(capsule.summary.length).toBeGreaterThan(0);
    expect(capsule.summary).toBe(
      "Synthesis of tooling/package-manager: prefer pnpm for workspace commands; npm is deprecated for this repo"
    );
    // SOUL_SYNTHESIS_CREATED follows the three resolve events through the single
    // atomic accept-with-events call.
    expect(harness.events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED
    ]);
    expect(harness.order.filter((entry) => entry.startsWith("repo:"))).toEqual([
      "repo:acceptPendingSynthesisCreateWithEvents"
    ]);
  });

  it("produces a reproducible deterministic summary (no LLM, no network)", async () => {
    const build = async () => {
      const proposal = createSynthesisProposal("librarian.synthesis", ["ev-1", "ev-2"]);
      const harness = createHarness({
        proposal,
        gistsByEvidence: {
          "ev-1": "prefer pnpm for workspace commands",
          "ev-2": "npm is deprecated for this repo"
        }
      });
      await harness.workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "confirmed",
          reviewer_identity: "user:reviewer-1"
        },
        { workspaceId: "ws1", runId: null, agentTarget: "cli", sessionId: "session-1" }
      );
      return harness.capsules[0]!.summary;
    };

    const first = await build();
    const second = await build();
    expect(first).toBe(second);
  });

  it("lands a member whose evidence intersects the capsule in source_memory_refs", async () => {
    const proposal = createSynthesisProposal("librarian.synthesis", ["ev-1"]);
    const harness = createHarness({
      proposal,
      gistsByEvidence: { "ev-1": "prefer pnpm" },
      memberObjectIdsByEvidence: { "ev-1": ["mem-intersecting"] }
    });

    await harness.workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "confirmed",
        reviewer_identity: "user:reviewer-1"
      },
      { workspaceId: "ws1", runId: null, agentTarget: "cli", sessionId: "session-1" }
    );

    expect(harness.capsules).toHaveLength(1);
    expect(harness.capsules[0]!.source_memory_refs).toEqual(["mem-intersecting"]);
  });

  it("creates a topic-only capsule for a bootstrapping synthesis_candidate (no evidence)", async () => {
    const proposal = createSynthesisProposal("bootstrapping.synthesis_candidate", []);
    const harness = createHarness({ proposal, gistsByEvidence: {} });

    await harness.workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "confirmed",
        reviewer_identity: "user:reviewer-1"
      },
      { workspaceId: "ws1", runId: null, agentTarget: "cli", sessionId: "session-1" }
    );

    expect(harness.capsules).toHaveLength(1);
    const capsule = harness.capsules[0]!;
    expect(capsule.topic_key).toBe("tooling-pattern");
    expect(capsule.evidence_refs).toEqual([]);
    // No evidence => no cluster members to preserve; the compress arm has nothing
    // to earn against (the resolver is never even queried).
    expect(capsule.source_memory_refs).toEqual([]);
    expect(capsule.summary).toBe("Synthesis of tooling-pattern: no member evidence");
  });

  it("does not create a capsule when a synthesis proposal is rejected", async () => {
    const proposal = createSynthesisProposal("librarian.synthesis", ["ev-1"]);
    const harness = createHarness({
      proposal,
      gistsByEvidence: { "ev-1": "prefer pnpm" }
    });

    const reviewed = await harness.workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "reject",
        reason: "not durable",
        reviewer_identity: "user:reviewer-1"
      },
      { workspaceId: "ws1", runId: null, agentTarget: "cli", sessionId: "session-1" }
    );

    expect(reviewed.resolution_state).toBe(ProposalResolutionState.REJECTED);
    expect(harness.capsules).toHaveLength(0);
    expect(harness.events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(harness.order.filter((entry) => entry.startsWith("repo:"))).toEqual([
      "repo:updatePendingResolutionWithEvents"
    ]);
  });

  it("fails NOT_FOUND when a referenced evidence gist is missing", async () => {
    const proposal = createSynthesisProposal("librarian.synthesis", ["ev-1", "ev-missing"]);
    const harness = createHarness({
      proposal,
      gistsByEvidence: { "ev-1": "prefer pnpm", "ev-missing": null }
    });

    await expect(
      harness.workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "confirmed",
          reviewer_identity: "user:reviewer-1"
        },
        { workspaceId: "ws1", runId: null, agentTarget: "cli", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(harness.capsules).toHaveLength(0);
  });
});
