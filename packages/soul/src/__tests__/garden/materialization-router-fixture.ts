import { vi, type Mock } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  type MaterializationRouterDeps,
  type PathCandidateMintOutcome,
  type PathRelationProposalPayload
} from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

type EvidenceCreate = MaterializationRouterDeps["evidenceService"]["create"];
type EvidenceDeleteCreated = MaterializationRouterDeps["evidenceService"]["deleteCreatedEvidence"];
type MemoryCreate = MaterializationRouterDeps["memoryService"]["create"];
type SynthesisCreate = MaterializationRouterDeps["synthesisService"]["create"];
type ClaimCreate = MaterializationRouterDeps["claimService"]["create"];
type SubmitCandidate = NonNullable<
  MaterializationRouterDeps["pathCandidateSinkPort"]
>["submitCandidate"];

export type RunWithDecisionFn = NonNullable<
  MaterializationRouterDeps["reconciliationPort"]
>["runWithDecision"];
export type DetectFn = NonNullable<
  MaterializationRouterDeps["conflictDetectionPort"]
>["detectAndLinkConflicts"];
export type EnqueueFn = NonNullable<MaterializationRouterDeps["enrichPendingPort"]>["enqueue"];

export function createSignal(
  overrides: Partial<CandidateMemorySignal> = {}
): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "triaged",
    object_kind: "constraint",
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
      excerpt: "Never print secrets."
    },
    created_at: "2026-03-21T00:00:00.000Z",
    ...overrides
  };
}

export function createRouter() {
  return new MaterializationRouter(createDeps());
}

export interface MockCreatedObject {
  readonly object_kind: string;
  readonly object_id: string;
}

export interface MockCreatedObjectWithEnrich extends MockCreatedObject {
  readonly enrichmentEnqueued?: boolean;
}

type MockPathRelationProposalInput = {
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourceSignalId: string;
  readonly targetObjectId: string;
  readonly reason: string;
  readonly proposedPathRelation: PathRelationProposalPayload;
};

export type MockPathRelationProposalFn = (
  input: MockPathRelationProposalInput
) => Promise<MockCreatedObject>;

export function createPathRelationProposalPort() {
  let proposalCounter = 0;

  return {
    assertPathRelationProposalAvailable: vi.fn(async () => undefined),
    createPathRelationProposal: vi.fn<MockPathRelationProposalFn>(async () => {
      proposalCounter += 1;
      return {
        object_kind: "proposal",
        object_id: `proposal-${proposalCounter}`
      };
    })
  };
}

export interface TestDeps extends MaterializationRouterDeps {
  readonly evidenceService: {
    create: Mock<EvidenceCreate>;
    deleteCreatedEvidence: Mock<EvidenceDeleteCreated>;
  };
  readonly memoryService: { create: Mock<MemoryCreate> };
  readonly synthesisService: { create: Mock<SynthesisCreate> };
  readonly claimService: { create: Mock<ClaimCreate> };
  readonly pathCandidateSinkPort: { submitCandidate: Mock<SubmitCandidate> };
  readonly handoffGapHandler: InMemoryHandoffGapHandler;
}

export function createDeps(): TestDeps {
  let evidenceCounter = 0;

  return {
    evidenceService: {
      create: vi.fn<EvidenceCreate>(async () => {
        evidenceCounter += 1;
        return {
          object_kind: "evidence_capsule",
          object_id: `evidence-${evidenceCounter}`
        } as never;
      }),
      deleteCreatedEvidence: vi.fn<EvidenceDeleteCreated>(async () => undefined)
    },
    memoryService: {
      create: vi.fn<MemoryCreate>(async () =>
        ({
          object_kind: "memory_entry",
          object_id: "memory-1"
        }) as never
      )
    },
    synthesisService: {
      create: vi.fn<SynthesisCreate>(async () =>
        ({
          object_kind: "synthesis_capsule",
          object_id: "synthesis-1"
        }) as never
      )
    },
    claimService: {
      create: vi.fn<ClaimCreate>(async () =>
        ({
          object_kind: "claim_form",
          object_id: "claim-1"
        }) as never
      )
    },
    pathCandidateSinkPort: {
      submitCandidate: vi.fn<SubmitCandidate>(async () => "applied" as PathCandidateMintOutcome)
    },
    handoffGapHandler: new InMemoryHandoffGapHandler()
  };
}

export function fakeReconciliationPort(
  verdict: {
    readonly kind: "add" | "update" | "noop";
    readonly survivingObjectId?: string;
    readonly runConflictScan?: boolean;
    readonly reason?: string;
  },
  options: { readonly updateFails?: boolean } = {}
): {
  readonly reconciliationPort: { runWithDecision: Mock<RunWithDecisionFn> };
  readonly appliedVerdicts: string[];
} {
  const appliedVerdicts: string[] = [];
  const runWithDecision = vi.fn<RunWithDecisionFn>(async (_input, applyVerdict) => {
    const decisionView = {
      kind: verdict.kind,
      ...(verdict.survivingObjectId === undefined
        ? {}
        : { survivingObjectId: verdict.survivingObjectId }),
      runConflictScan: verdict.runConflictScan ?? false,
      reason: verdict.reason ?? "verdict"
    } as const;
    appliedVerdicts.push(decisionView.kind);
    await applyVerdict(decisionView);
    if (verdict.kind === "update" && options.updateFails) {
      const degraded = {
        kind: "add" as const,
        runConflictScan: true,
        reason: "LLM UPDATE could not be applied - added with conflict scan"
      };
      appliedVerdicts.push(degraded.kind);
      await applyVerdict(degraded);
      return degraded;
    }
    return decisionView;
  });
  return { reconciliationPort: { runWithDecision }, appliedVerdicts };
}
