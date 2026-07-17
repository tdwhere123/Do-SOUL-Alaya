import { describe, expect, it, vi, type Mock } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  type MaterializationRouterDeps,
  type RouteTarget
} from "@do-soul/alaya-soul";
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
  const { source_observation = null, ...signalOverrides } = overrides;
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
    ...signalOverrides,
    source_observation
  };
}

interface RoutingCase {
  readonly object_kind: string;
  readonly expected: RouteTarget;
}

const OBJECT_KIND_ROUTING_TABLE: readonly RoutingCase[] = [
  { object_kind: "scope", expected: "signal_only" },
  { object_kind: "task_scope", expected: "signal_only" },
  { object_kind: "workflow_preference", expected: "signal_only" },
  { object_kind: "activity", expected: "memory_entry_only" },
  { object_kind: "review_scope", expected: "evidence_only" },
  { object_kind: "workspace_status", expected: "evidence_short_ttl" },
  { object_kind: "project_state", expected: "evidence_short_ttl" },
  { object_kind: "preference", expected: "memory_and_claim_draft" },
  { object_kind: "decision", expected: "memory_and_claim_draft" },
  { object_kind: "outcome", expected: "memory_entry_only" },
  { object_kind: "reference", expected: "memory_entry_only" },
  { object_kind: "task_state", expected: "memory_entry_only" }
];

describe("MaterializationRouter routing-by-object_kind", () => {
  for (const testCase of OBJECT_KIND_ROUTING_TABLE) {
    it(`routes object_kind=${testCase.object_kind} to ${testCase.expected}`, () => {
      const router = new MaterializationRouter(createDeps());

      const target = router.route(
        createSignal({
          object_kind: testCase.object_kind,
          signal_kind: "potential_claim",
          confidence: 0.8,
          evidence_refs: []
        })
      );

      expect(target.route_target).toBe(testCase.expected);
    });
  }

  it("routes unknown object_kind under potential_claim to evidence_only fallback when confidence < 0.5", () => {
    const router = new MaterializationRouter(createDeps());

    const target = router.route(
      createSignal({
        object_kind: "totally_unknown_kind",
        signal_kind: "potential_claim",
        confidence: 0.4,
        evidence_refs: []
      })
    );

    expect(target.route_target).toBe("evidence_only");
  });

  // invariant: high-confidence unknown object_kind must NOT escalate
  // into a draft claim — that would re-introduce the producer-side
  // claim collapse the routing table was meant to break. Truly
  // unknown labels route to evidence_only regardless of confidence.
  it("routes unknown object_kind under potential_claim to evidence_only even at high confidence", () => {
    const router = new MaterializationRouter(createDeps());

    const target = router.route(
      createSignal({
        object_kind: "totally_unknown_kind",
        signal_kind: "potential_claim",
        confidence: 0.95,
        evidence_refs: ["msg-1", "msg-2"]
      })
    );

    expect(target.kind).toBe("evidence_only");
    expect(target.route_target).toBe("evidence_only");
  });

  it("retains an unknown object_kind high-confidence claim as memory_entry_only when retainUnroutedHighConfidenceFacts is set", () => {
    const router = new MaterializationRouter({
      ...createDeps(),
      retainUnroutedHighConfidenceFacts: true
    });

    const target = router.route(
      createSignal({
        object_kind: "totally_unknown_kind",
        signal_kind: "potential_claim",
        confidence: 0.95,
        evidence_refs: ["msg-1", "msg-2"]
      })
    );

    // The open-vocabulary fact stays recallable (memory_entry, no draft claim)
    // instead of dropping to evidence_only — the production ingest the bench
    // now exercises after dropping the seed-side canonicalize-to-`fact` mask.
    expect(target.route_target).toBe("memory_entry_only");
  });

  it("still defers a low-confidence unknown object_kind even when retainUnroutedHighConfidenceFacts is set", () => {
    const router = new MaterializationRouter({
      ...createDeps(),
      retainUnroutedHighConfidenceFacts: true
    });

    const target = router.route(
      createSignal({
        object_kind: "totally_unknown_kind",
        signal_kind: "potential_claim",
        confidence: 0.2,
        evidence_refs: ["msg-1"]
      })
    );

    // retain only covers the high-confidence (>=0.5) branch; the confidence
    // gate below 0.3 still defers.
    expect(target.route_target).toBe("deferred");
  });

  it("routes unknown object_kind under potential_preference to evidence_only at high confidence", () => {
    const router = new MaterializationRouter(createDeps());

    const target = router.route(
      createSignal({
        object_kind: "newly_minted_label",
        signal_kind: "potential_preference",
        confidence: 0.9,
        evidence_refs: ["msg-1"]
      })
    );

    expect(target.route_target).toBe("evidence_only");
  });

  it("legacy object_kind=constraint is now enumerated as memory_and_claim_draft (was fallback)", () => {
    const router = new MaterializationRouter(createDeps());

    const target = router.route(
      createSignal({
        object_kind: "constraint",
        signal_kind: "potential_claim",
        confidence: 0.8,
        evidence_refs: ["msg-1"]
      })
    );

    expect(target.kind).toBe("memory_and_claim");
    expect(target.route_target).toBe("memory_and_claim_draft");
  });

  for (const claimCapableKind of [
    "procedure",
    "hazard",
    "factual_policy",
    "exception",
    "glossary",
    "episode"
  ]) {
    it(`enumerates claim-capable object_kind=${claimCapableKind} as memory_and_claim_draft`, () => {
      const router = new MaterializationRouter(createDeps());

      const target = router.route(
        createSignal({
          object_kind: claimCapableKind,
          signal_kind: "potential_claim",
          confidence: 0.8,
          evidence_refs: ["msg-1"]
        })
      );

      expect(target.route_target).toBe("memory_and_claim_draft");
    });
  }

  it("enumerates object_kind=fact as memory_entry_only (no claim)", () => {
    const router = new MaterializationRouter(createDeps());

    const target = router.route(
      createSignal({
        object_kind: "fact",
        signal_kind: "potential_claim",
        confidence: 0.8,
        evidence_refs: ["msg-1"]
      })
    );

    expect(target.route_target).toBe("memory_entry_only");
  });

  it("routes potential_preference by object_kind too (decision -> memory_and_claim_draft)", () => {
    const router = new MaterializationRouter(createDeps());

    const target = router.route(
      createSignal({
        object_kind: "decision",
        signal_kind: "potential_preference",
        confidence: 0.6,
        evidence_refs: []
      })
    );

    expect(target.route_target).toBe("memory_and_claim_draft");
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
