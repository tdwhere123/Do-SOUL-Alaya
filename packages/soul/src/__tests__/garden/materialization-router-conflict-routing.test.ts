import { describe, expect, it, vi, type Mock } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  type MaterializationRouterDeps} from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

type ConflictDetectionPort = NonNullable<MaterializationRouterDeps["conflictDetectionPort"]>;
type EvidenceCreate = MaterializationRouterDeps["evidenceService"]["create"];
type EvidenceDeleteCreated = MaterializationRouterDeps["evidenceService"]["deleteCreatedEvidence"];
type MemoryCreate = MaterializationRouterDeps["memoryService"]["create"];
type SynthesisCreate = MaterializationRouterDeps["synthesisService"]["create"];
type ClaimCreate = MaterializationRouterDeps["claimService"]["create"];

// invariant: routes-by-object_kind suite. Asserts MaterializationRouter
// diversifies the producer-side so the live ontology no longer collapses
// every potential_claim / potential_preference into memory_and_claim,
// locks claim_status=draft at the wire boundary, and routes
// potential_conflict to ConflictDetectionPort.evaluate.
// see also: packages/soul/src/garden/materialization-router/router.ts route()
// see also: packages/core/src/governance/claim-service.ts create() (DRAFT default)
function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "triaged",
    object_kind: "preference",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.8,
    evidence_refs: ["msg-1"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      excerpt: "Sample distilled fact."
    },
    created_at: "2026-03-21T00:00:00.000Z",
    ...overrides
  };
}



describe("MaterializationRouter potential_conflict routing", () => {
  it("routes potential_conflict to ConflictDetectionPort.evaluate (not questionable-evidence fallback)", async () => {
    const deps = createDeps();
    const evaluate = vi.fn<NonNullable<ConflictDetectionPort["evaluate"]>>(async () => undefined);
    const detectAndLinkConflicts = vi.fn<ConflictDetectionPort["detectAndLinkConflicts"]>(
      async () => undefined
    );
    const router = new MaterializationRouter({
      ...deps,
      conflictDetectionPort: { detectAndLinkConflicts, evaluate }
    });

    const signal = createSignal({
      signal_kind: "potential_conflict",
      object_kind: "preference",
      confidence: 0.7,
      evidence_refs: [],
      raw_payload: { distilled_fact: "Memory A contradicts memory B." }
    });

    const target = router.route(signal);
    expect(target.route_target).toBe("conflict_evaluation");

    const result = await router.materializeSignal(signal);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][0]).toMatchObject({
      signalId: "signal-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      objectKind: "preference",
      content: "Memory A contradicts memory B."
    });
    expect(detectAndLinkConflicts).not.toHaveBeenCalled();
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.route_target).toBe("conflict_evaluation");
  });

  it("defers potential_conflict when evaluate is unavailable rather than writing questionable evidence", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        signal_kind: "potential_conflict",
        confidence: 0.7,
        evidence_refs: []
      })
    );

    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(result.target_kind).toBe("deferred");
    expect(result.route_target).toBe("conflict_evaluation");
    expect(result.success).toBe(true);
  });
});


interface TestDeps {
  readonly evidenceService: { create: Mock<EvidenceCreate>; deleteCreatedEvidence: Mock<EvidenceDeleteCreated> };
  readonly memoryService: { create: Mock<MemoryCreate> };
  readonly synthesisService: { create: Mock<SynthesisCreate> };
  readonly claimService: { create: Mock<ClaimCreate> };
  readonly handoffGapHandler: InMemoryHandoffGapHandler;
  claimServiceLastStatus(): string | undefined;
}

function createDeps(): TestDeps {
  let evidenceCounter = 0;
  let lastClaimStatus: string | undefined;

  const evidenceService = {
    create: vi.fn<EvidenceCreate>(async () => {
      evidenceCounter += 1;
      return {
        object_kind: "evidence_capsule",
        object_id: `evidence-${evidenceCounter}`
      } as never;
    }),
    deleteCreatedEvidence: vi.fn<EvidenceDeleteCreated>(async () => undefined)
  };
  const memoryService = {
    create: vi.fn<MemoryCreate>(async () =>
      ({
        object_kind: "memory_entry",
        object_id: "memory-1"
      }) as never
    )
  };
  const synthesisService = {
    create: vi.fn<SynthesisCreate>(async () =>
      ({
        object_kind: "synthesis_capsule",
        object_id: "synthesis-1"
      }) as never
    )
  };
  const claimService = {
    create: vi.fn<ClaimCreate>(async () => {
      // mirror ClaimService.create real default; see
      // packages/core/src/governance/claim-service.ts ClaimLifecycleState.DRAFT default.
      lastClaimStatus = "draft";
      return {
        object_kind: "claim_form",
        object_id: "claim-1",
        claim_status: "draft"
      } as never;
    })
  };
  return {
    evidenceService,
    memoryService,
    synthesisService,
    claimService,
    handoffGapHandler: new InMemoryHandoffGapHandler(),
    claimServiceLastStatus: () => lastClaimStatus
  };
}
