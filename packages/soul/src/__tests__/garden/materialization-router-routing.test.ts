import { describe, expect, it, vi, type Mock } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  type MaterializationRouterDeps,
  type RouteTarget
} from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

type ConflictDetectionPort = NonNullable<MaterializationRouterDeps["conflictDetectionPort"]>;
type EvidenceCreate = MaterializationRouterDeps["evidenceService"]["create"];
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

interface RoutingCase {
  readonly object_kind: string;
  readonly expected: RouteTarget;
}

const OBJECT_KIND_ROUTING_TABLE: readonly RoutingCase[] = [
  { object_kind: "scope", expected: "signal_only" },
  { object_kind: "task_scope", expected: "signal_only" },
  { object_kind: "workflow_preference", expected: "signal_only" },
  { object_kind: "activity", expected: "evidence_only" },
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

describe("MaterializationRouter producer-side diversifiers", () => {
  // invariant: pickPrecedenceBasis lockstep with derivePrecedenceBasis in
  // packages/core/src/governance/claim-service.ts. Priority: user_override > authority
  // > recency > evidence_strength. Garden cannot import core, so the two
  // helpers must stay in sync through identical truth-table tests.
  const PRECEDENCE_TABLE: ReadonlyArray<{
    readonly name: string;
    readonly overrides: Partial<CandidateMemorySignal>;
    readonly expected: string;
  }> = [
    {
      name: "user_seed source wins user_override",
      overrides: {
        source: "user_seed",
        object_kind: "preference",
        signal_kind: "potential_claim",
        evidence_refs: ["msg-1"]
      },
      expected: "user_override"
    },
    {
      name: "raw_payload.user_override=true wins user_override (priority over authority)",
      overrides: {
        source: "model_tool",
        object_kind: "constraint",
        signal_kind: "potential_claim",
        evidence_refs: ["msg-1"],
        raw_payload: { user_override: true, excerpt: "x" }
      },
      expected: "user_override"
    },
    {
      name: "constraint object_kind (strict enforcement) wins authority",
      overrides: {
        source: "model_tool",
        object_kind: "constraint",
        signal_kind: "potential_claim",
        evidence_refs: ["msg-1"]
      },
      expected: "authority"
    },
    {
      name: "supersedes_refs present wins recency (no override, not strict)",
      overrides: {
        source: "model_tool",
        object_kind: "preference",
        signal_kind: "potential_claim",
        evidence_refs: ["msg-1"],
        supersedes_refs: ["claim-prev"],
        raw_payload: { excerpt: "x" }
      },
      expected: "recency"
    },
    {
      name: "no markers falls through to evidence_strength",
      overrides: {
        source: "model_tool",
        object_kind: "preference",
        signal_kind: "potential_claim",
        evidence_refs: ["msg-1"]
      },
      expected: "evidence_strength"
    },
    {
      name: "user_override beats supersede + strict (priority short-circuit)",
      overrides: {
        source: "user_seed",
        object_kind: "constraint",
        signal_kind: "potential_claim",
        evidence_refs: ["msg-1"],
        supersedes_refs: ["claim-prev"],
        raw_payload: { excerpt: "x" }
      },
      expected: "user_override"
    },
    {
      name: "authority beats supersede (priority short-circuit)",
      overrides: {
        source: "model_tool",
        object_kind: "constraint",
        signal_kind: "potential_claim",
        evidence_refs: ["msg-1"],
        supersedes_refs: ["claim-prev"],
        raw_payload: { excerpt: "x" }
      },
      expected: "authority"
    }
  ];

  for (const row of PRECEDENCE_TABLE) {
    it(`pickPrecedenceBasis: ${row.name}`, async () => {
      const deps = createDeps();
      const router = new MaterializationRouter(deps);

      await router.materializeSignal(
        createSignal({
          confidence: 0.8,
          ...row.overrides
        })
      );

      expect(deps.claimService.create).toHaveBeenCalledTimes(1);
      const claimInput = deps.claimService.create.mock.calls[0][0] as Record<string, unknown>;
      expect(claimInput.precedence_basis).toBe(row.expected);
    });
  }

  // invariant: evidence_kind diversifies producer-side. user_seed/import
  // produce user_statement; signals with evidence_refs produce
  // external_reference; everything else stays inferred.
  it("pickEvidenceKind: user_seed source produces user_statement", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        source: "user_seed",
        object_kind: "outcome",
        signal_kind: "potential_claim",
        confidence: 0.9,
        evidence_refs: []
      })
    );

    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    const evidenceInput = deps.evidenceService.create.mock.calls[0][0] as Record<string, unknown>;
    expect(evidenceInput.evidence_kind).toBe("user_statement");
  });

  it("pickEvidenceKind: evidence_refs.length > 0 produces external_reference", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        source: "model_tool",
        object_kind: "outcome",
        signal_kind: "potential_claim",
        confidence: 0.7,
        evidence_refs: ["msg-1", "msg-2"]
      })
    );

    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    const evidenceInput = deps.evidenceService.create.mock.calls[0][0] as Record<string, unknown>;
    expect(evidenceInput.evidence_kind).toBe("external_reference");
  });

  it("pickEvidenceKind: garden_compile with no evidence_refs falls through to inferred", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        source: "garden_compile",
        object_kind: "outcome",
        signal_kind: "potential_claim",
        confidence: 0.7,
        evidence_refs: []
      })
    );

    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    const evidenceInput = deps.evidenceService.create.mock.calls[0][0] as Record<string, unknown>;
    expect(evidenceInput.evidence_kind).toBe("inferred");
  });

  // invariant: formation_kind for model_tool splits derived vs inferred by
  // first-class source_memory_refs. Non-empty -> derived (builds on
  // existing memory); empty/missing -> inferred (plain LLM emission).
  it("toFormationKind(model_tool): source_memory_refs non-empty produces derived", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        source: "model_tool",
        object_kind: "outcome",
        signal_kind: "potential_claim",
        confidence: 0.8,
        evidence_refs: ["msg-1"],
        source_memory_refs: ["memory-prev"],
        raw_payload: {
          excerpt: "Distilled."
        }
      })
    );

    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    const memoryInput = deps.memoryService.create.mock.calls[0][0] as Record<string, unknown>;
    expect(memoryInput.formation_kind).toBe("derived");
  });

  it("toFormationKind(model_tool): source_memory_refs missing produces inferred", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        source: "model_tool",
        object_kind: "outcome",
        signal_kind: "potential_claim",
        confidence: 0.8,
        evidence_refs: ["msg-1"],
        raw_payload: { excerpt: "Distilled." }
      })
    );

    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    const memoryInput = deps.memoryService.create.mock.calls[0][0] as Record<string, unknown>;
    expect(memoryInput.formation_kind).toBe("inferred");
  });
});

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
    const claimInput = deps.claimService.create.mock.calls[0][0] as Record<string, unknown>;
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
      const claimInput = deps.claimService.create.mock.calls[0][0] as Record<string, unknown>;
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
  readonly evidenceService: { create: Mock<EvidenceCreate> };
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
    })
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
