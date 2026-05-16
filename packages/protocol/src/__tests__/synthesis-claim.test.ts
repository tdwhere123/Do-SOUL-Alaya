import { describe, expect, it } from "vitest";
import {
  canonicalGovernanceSubject,
  CLAIM_KIND_PRIORITY,
  ClaimCandidateConditionsSchema,
  ClaimFormSchema,
  ClaimKind,
  ClaimKindSchema,
  EnforcementLevel,
  EnforcementLevelSchema,
  OriginTier,
  OriginTierSchema,
  PrecedenceBasis,
  PrecedenceBasisSchema,
  SynthesisCapsuleSchema,
  SynthesisStatus,
  SynthesisStatusSchema,
  isValidSynthesisTransition,
  isValidClaimTransition,
  type ClaimForm,
  type ClaimCandidateConditions
} from "../index.js";
import type { GovernanceSubject } from "../index.js";

type IfEquals<X, Y, A = true, B = false> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? A : B;
type AssertTrue<T extends true> = T;
type _ClaimFormGovernanceSubjectTypeCheck = AssertTrue<
  IfEquals<ClaimForm["governance_subject"], GovernanceSubject>
>;
type _ClaimCandidateConditionKeys = AssertTrue<
  IfEquals<
    keyof ClaimCandidateConditions,
    | "min_evidence_count"
    | "min_authority_rounds"
    | "stability_duration_ms"
    | "no_active_contradictions"
    | "scope_class_determined"
    | "governance_subject_compilable"
  >
>;

const validTimestamp = "2026-03-20T00:00:00.000Z";

const synthesisBase = {
  object_id: "0ab2f546-8a58-4f38-8ba8-bca780eb5375",
  object_kind: "synthesis_capsule",
  schema_version: 1,
  created_at: validTimestamp,
  updated_at: validTimestamp,
  created_by: "user",
  lifecycle_state: "active",
  topic_key: "tooling/package-manager",
  synthesis_type: "phase_synthesis",
  summary: "Use pnpm for this repository.",
  evidence_refs: ["evidence-1", "evidence-2"],
  source_memory_refs: ["memory-1"],
  workspace_id: "workspace-1",
  run_id: "run-1",
  synthesis_status: "working"
} as const;

const claimBase = {
  object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
  object_kind: "claim_form",
  schema_version: 1,
  created_at: validTimestamp,
  updated_at: validTimestamp,
  created_by: "user",
  lifecycle_state: "active",
  governance_subject: canonicalGovernanceSubject("code_style", { language: "TypeScript" }),
  claim_kind: "constraint",
  scope_class: "project",
  enforcement_level: "strict",
  origin_tier: "user_explicit",
  precedence_basis: "authority",
  proposition_digest: "Use pnpm for workspace commands.",
  evidence_refs: ["evidence-1"],
  source_object_refs: ["synthesis-1"],
  workspace_id: "workspace-1",
  claim_status: "draft"
} as const;

describe("SynthesisCapsuleSchema", () => {
  it("parses a synthesis capsule round-trip", () => {
    expect(SynthesisCapsuleSchema.parse(synthesisBase)).toEqual(synthesisBase);
  });

  it("keeps synthesis status enum complete and closed", () => {
    expect(SynthesisStatusSchema.options).toEqual(["working", "stable", "superseded", "archived"]);
    expect(Object.values(SynthesisStatus)).toEqual(["working", "stable", "superseded", "archived"]);
  });

  it("SynthesisCapsule schema no longer carries the retired promotion lifecycle fields", () => {
    const parsed = SynthesisCapsuleSchema.parse(synthesisBase) as Record<string, unknown>;
    expect(parsed.authority_round_count).toBeUndefined();
    expect(parsed.cooldown_until).toBeUndefined();
    expect(parsed.promotion_state).toBeUndefined();
  });

  it("accepts all legal synthesis status transitions", () => {
    const validTransitions: ReadonlyArray<
      readonly [typeof synthesisBase.synthesis_status, typeof synthesisBase.synthesis_status]
    > = [
      ["working", "stable"],
      ["stable", "superseded"],
      ["superseded", "archived"]
    ];

    for (const [from, to] of validTransitions) {
      expect(isValidSynthesisTransition(from, to)).toBe(true);
    }
  });

  it("rejects illegal synthesis status transitions", () => {
    const invalidTransitions: ReadonlyArray<
      readonly [typeof synthesisBase.synthesis_status, typeof synthesisBase.synthesis_status]
    > = [
      ["working", "superseded"],
      ["working", "archived"],
      ["stable", "working"],
      ["archived", "working"]
    ];

    for (const [from, to] of invalidTransitions) {
      expect(isValidSynthesisTransition(from, to)).toBe(false);
    }
  });
});

describe("ClaimFormSchema", () => {
  it("parses a claim form round-trip", () => {
    expect(ClaimFormSchema.parse(claimBase)).toEqual(claimBase);
  });

  it("uses the governance_subject produced by the compiler", () => {
    const subject = canonicalGovernanceSubject("code_style", { language: "TypeScript" });
    const parsed = ClaimFormSchema.parse({
      ...claimBase,
      governance_subject: subject
    });

    expect(parsed.governance_subject).toEqual(subject);
  });

  it("accepts all legal claim lifecycle transitions", () => {
    const validTransitions: ReadonlyArray<readonly [ClaimForm["claim_status"], ClaimForm["claim_status"]]> = [
      ["draft", "active"],
      ["active", "contested"],
      ["active", "superseded"],
      ["active", "archived"],
      ["contested", "winner"],
      ["contested", "rejected"],
      ["contested", "archived"],
      ["winner", "superseded"],
      ["winner", "archived"],
      ["superseded", "archived"],
      ["rejected", "archived"]
    ];

    for (const [from, to] of validTransitions) {
      expect(isValidClaimTransition(from, to)).toBe(true);
    }
  });

  it("rejects illegal claim lifecycle transitions", () => {
    const invalidTransitions: ReadonlyArray<readonly [ClaimForm["claim_status"], ClaimForm["claim_status"]]> = [
      ["draft", "contested"],
      ["draft", "winner"],
      ["active", "winner"],
      ["winner", "active"],
      ["rejected", "active"],
      ["archived", "active"]
    ];

    for (const [from, to] of invalidTransitions) {
      expect(isValidClaimTransition(from, to)).toBe(false);
    }
  });

  it("does not allow ClaimForm to self-declare victory from draft", () => {
    expect(isValidClaimTransition("draft", "winner")).toBe(false);
  });

  it("rejects self-loop claim lifecycle transitions", () => {
    const selfLoops: ReadonlyArray<ClaimForm["claim_status"]> = [
      "draft",
      "active",
      "contested",
      "winner",
      "superseded",
      "rejected",
      "archived"
    ];

    for (const state of selfLoops) {
      expect(isValidClaimTransition(state, state)).toBe(false);
    }
  });
});

describe("Claim enums and constants", () => {
  it("keeps ClaimKind enum complete and closed", () => {
    expect(ClaimKindSchema.options).toEqual([
      "constraint",
      "preference",
      "procedure",
      "exception",
      "factual_policy"
    ]);
    expect(Object.values(ClaimKind)).toEqual([
      "constraint",
      "preference",
      "procedure",
      "exception",
      "factual_policy"
    ]);
  });

  it("exports the expected ClaimKind disambiguation priority", () => {
    expect(CLAIM_KIND_PRIORITY).toEqual({
      exception: 5,
      constraint: 4,
      procedure: 3,
      preference: 2,
      factual_policy: 1
    });
  });

  it("keeps EnforcementLevel enum complete and closed", () => {
    expect(EnforcementLevelSchema.options).toEqual(["strict", "preferred"]);
    expect(Object.values(EnforcementLevel)).toEqual(["strict", "preferred"]);
  });

  it("keeps OriginTier enum complete and closed", () => {
    expect(OriginTierSchema.options).toEqual([
      "user_explicit",
      "compiler_extracted",
      "review_accepted",
      "seed",
      "imported"
    ]);
    expect(Object.values(OriginTier)).toEqual([
      "user_explicit",
      "compiler_extracted",
      "review_accepted",
      "seed",
      "imported"
    ]);
  });

  it("keeps PrecedenceBasis enum complete and closed", () => {
    expect(PrecedenceBasisSchema.options).toEqual([
      "recency",
      "authority",
      "evidence_strength",
      "user_override"
    ]);
    expect(Object.values(PrecedenceBasis)).toEqual([
      "recency",
      "authority",
      "evidence_strength",
      "user_override"
    ]);
  });
});

describe("ClaimCandidateConditionsSchema", () => {
  it("parses the six claim-candidate condition fields", () => {
    const value = {
      min_evidence_count: 2,
      min_authority_rounds: 1,
      stability_duration_ms: 60_000,
      no_active_contradictions: true,
      scope_class_determined: true,
      governance_subject_compilable: true
    } as const;

    expect(ClaimCandidateConditionsSchema.parse(value)).toEqual(value);
  });
});
