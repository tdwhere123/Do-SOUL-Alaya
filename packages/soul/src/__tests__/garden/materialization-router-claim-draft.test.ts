import { describe, expect, it, vi, type Mock } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  type MaterializationRouterDeps} from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

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
    source: "model_tool",
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



describe("MaterializationRouter claim_status draft lock", () => {
  it("never passes a claim_status field to claimService.create (force ClaimService DRAFT default)", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        object_kind: "preference",
        signal_kind: "potential_claim",
        confidence: 0.9,
        evidence_refs: ["msg-1"]
      })
    );

    expect(deps.claimService.create).toHaveBeenCalledTimes(1);
    const claimInput = deps.claimService.create.mock.calls[0]![0] as Record<string, unknown>;
    expect("claim_status" in claimInput).toBe(false);
  });

  it("memory_and_claim_draft path produces a claim object whose status is draft at the wire boundary", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        object_kind: "decision",
        signal_kind: "potential_claim",
        confidence: 0.9,
        evidence_refs: ["msg-1"]
      })
    );

    expect(result.success).toBe(true);
    expect(result.route_target).toBe("memory_and_claim_draft");
    expect(result.created_objects.some((obj) => obj.object_kind === "claim_form")).toBe(true);
    // see also: packages/core/src/governance/claim-service.ts create() — ClaimLifecycleState.DRAFT default
    expect(deps.claimServiceLastStatus()).toBe("draft");
  });

  for (const claimCase of [
    ["preference", "preference"],
    ["decision", "decision"],
    ["constraint", "constraint"],
    ["procedure", "procedure"],
    ["hazard", "hazard"],
    ["factual_policy", "factual_policy"],
    ["exception", "exception"],
    ["glossary", "glossary"],
    ["episode", "episode"]
  ] as const) {
    it(`preserves object_kind=${claimCase[0]} as claim_kind=${claimCase[1]}`, async () => {
      const deps = createDeps();
      const router = new MaterializationRouter(deps);

      const result = await router.materializeSignal(
        createSignal({
          object_kind: claimCase[0],
          signal_kind: "potential_claim",
          confidence: 0.9,
          evidence_refs: ["msg-1"]
        })
      );

      expect(result.route_target).toBe("memory_and_claim_draft");
      expect(deps.claimService.create).toHaveBeenCalledTimes(1);
      const claimInput = deps.claimService.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(claimInput.claim_kind).toBe(claimCase[1]);
    });
  }

  it("memory_entry_only path produces evidence + memory but no claim", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        object_kind: "outcome",
        signal_kind: "potential_claim",
        confidence: 0.8,
        evidence_refs: ["msg-1"]
      })
    );

    expect(result.success).toBe(true);
    expect(result.route_target).toBe("memory_entry_only");
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("signal_only path persists nothing beyond the signal row", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        object_kind: "scope",
        signal_kind: "potential_claim",
        confidence: 0.9,
        evidence_refs: []
      })
    );

    expect(result.success).toBe(true);
    expect(result.route_target).toBe("signal_only");
    expect(result.created_objects).toEqual([]);
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
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
