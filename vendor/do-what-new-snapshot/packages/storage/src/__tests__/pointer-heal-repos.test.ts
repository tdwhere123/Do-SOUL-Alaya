import { afterEach, describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
  PromotionState,
  RunMode,
  RunState,
  SynthesisStatus,
  WorkspaceKind,
  WorkspaceState,
  canonicalGovernanceSubject,
  type ClaimForm,
  type SynthesisCapsule
} from "@do-what/protocol";
import { initDatabase } from "../db.js";
import { SqliteClaimFormRepo } from "../repos/claim-form-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteSynthesisCapsuleRepo } from "../repos/synthesis-capsule-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createClaimForm(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "user",
    governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1", "evidence-2"],
    source_object_refs: ["synthesis-1", "synthesis-2"],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  };
}

function createSynthesisCapsule(overrides: Partial<SynthesisCapsule> = {}): SynthesisCapsule {
  return {
    object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "user",
    topic_key: "tooling/pnpm",
    synthesis_type: "phase_synthesis",
    authority_round_count: 0,
    cooldown_until: null,
    promotion_state: PromotionState.NONE,
    summary: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1", "evidence-2"],
    source_memory_refs: ["memory-1", "memory-2"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    synthesis_status: SynthesisStatus.WORKING,
    ...overrides
  };
}

describe("pointer-heal storage helpers", () => {
  it("clears only the targeted claim refs", async () => {
    const { claimRepo } = await createRepo();
    await claimRepo.create(createClaimForm());

    const afterEvidenceHeal = await claimRepo.clearEvidenceRef(
      "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      "evidence-1",
      "2026-03-28T01:00:00.000Z"
    );
    expect(afterEvidenceHeal.evidence_refs).toEqual(["evidence-2"]);
    expect(afterEvidenceHeal.source_object_refs).toEqual(["synthesis-1", "synthesis-2"]);
    expect(afterEvidenceHeal.updated_at).toBe("2026-03-28T01:00:00.000Z");

    const afterSourceHeal = await claimRepo.clearSourceObjectRef(
      "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      "synthesis-2",
      "2026-03-28T02:00:00.000Z"
    );
    expect(afterSourceHeal.evidence_refs).toEqual(["evidence-2"]);
    expect(afterSourceHeal.source_object_refs).toEqual(["synthesis-1"]);
    expect(afterSourceHeal.updated_at).toBe("2026-03-28T02:00:00.000Z");
  });

  it("clears only the targeted synthesis refs", async () => {
    const { synthesisRepo } = await createRepo();
    await synthesisRepo.create(createSynthesisCapsule());

    const afterEvidenceHeal = await synthesisRepo.clearEvidenceRef(
      "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
      "evidence-2",
      "2026-03-28T01:00:00.000Z"
    );
    expect(afterEvidenceHeal.evidence_refs).toEqual(["evidence-1"]);
    expect(afterEvidenceHeal.source_memory_refs).toEqual(["memory-1", "memory-2"]);
    expect(afterEvidenceHeal.updated_at).toBe("2026-03-28T01:00:00.000Z");

    const afterMemoryHeal = await synthesisRepo.clearSourceMemoryRef(
      "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
      "memory-1",
      "2026-03-28T02:00:00.000Z"
    );
    expect(afterMemoryHeal.evidence_refs).toEqual(["evidence-1"]);
    expect(afterMemoryHeal.source_memory_refs).toEqual(["memory-2"]);
    expect(afterMemoryHeal.updated_at).toBe("2026-03-28T02:00:00.000Z");
  });
});

async function createRepo(): Promise<{
  readonly claimRepo: SqliteClaimFormRepo;
  readonly synthesisRepo: SqliteSynthesisCapsuleRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    claimRepo: new SqliteClaimFormRepo(database),
    synthesisRepo: new SqliteSynthesisCapsuleRepo(database)
  };
}
