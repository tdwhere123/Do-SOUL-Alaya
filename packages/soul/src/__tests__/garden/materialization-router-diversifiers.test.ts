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
      const claimInput = deps.claimService.create.mock.calls[0]![0] as Record<string, unknown>;
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
    const evidenceInput = deps.evidenceService.create.mock.calls[0]![0] as Record<string, unknown>;
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
    const evidenceInput = deps.evidenceService.create.mock.calls[0]![0] as Record<string, unknown>;
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
    const evidenceInput = deps.evidenceService.create.mock.calls[0]![0] as Record<string, unknown>;
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
    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as Record<string, unknown>;
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
    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(memoryInput.formation_kind).toBe("inferred");
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
