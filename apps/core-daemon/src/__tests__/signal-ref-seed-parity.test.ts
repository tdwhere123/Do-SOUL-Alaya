import { describe, expect, it } from "vitest";
import {
  DERIVES_FROM_SEED_PROFILE,
  EXCEPTION_TO_SEED_PROFILE,
  type PathSeedProfile
} from "@do-soul/alaya-core";
import { SIGNAL_REF_SEED_SPECS, type SignalRefSeedSpec } from "@do-soul/alaya-soul";

// invariant: this guard pins the LIVE soul router seed table
// (SIGNAL_REF_SEED_SPECS, imported here — no hand-copied mirror) so a
// router-side edit cannot silently drift the agent-asserted *_refs
// seeding. The table is keyed by producer trust, not just by family:
//   - source_memory_refs (positive derives_from) stays value-equivalent
//     to DERIVES_FROM_SEED_PROFILE (attention_only / 0.5);
//   - exception_to_refs keeps the recall-neutral marker semantics
//     (recallBiasSign 0, magnitude 0, relation_kind/strength/evidence
//     matching EXCEPTION_TO_SEED_PROFILE) but DELIBERATELY DIVERGES on
//     governance: the agent-asserted ref seeds attention_only, not the
//     core profile's recall_allowed, because the ref is attacker-controllable;
//   - the NEGATIVE families (supersedes / contradicts / incompatible_with)
//     are AGENT-asserted, so they DELIBERATELY DIVERGE from the core
//     recall_allowed/0.9 negative profiles: they seed weak (attention_only
//     / strength 0.5) and must earn recall eligibility through plasticity.
//     The recall_allowed/0.9 negative band is reserved for SYSTEM-derived
//     negatives produced by ConflictDetectionService. This test pins both
//     the weak seed AND the divergence so neither regresses.
// see also: packages/soul/src/garden/materialization-router.ts SIGNAL_REF_SEED_SPECS.
// see also: packages/core/src/path-relation-proposal-service.ts seed profiles.
// see also: packages/core/src/conflict-detection-service.ts — SYSTEM negatives.
interface SignalRefSeedExpectation {
  readonly relationKind: string;
  readonly initialStrength: number;
  readonly governanceClass: string;
  readonly recallBiasSign: 1 | 0 | -1;
  readonly recallBiasMagnitude: number;
  readonly evidenceBasis: readonly string[];
}

function specByKey(key: SignalRefSeedSpec["signalRefsKey"]): SignalRefSeedSpec {
  const spec = SIGNAL_REF_SEED_SPECS.find((candidate) => candidate.signalRefsKey === key);
  if (spec === undefined) {
    throw new Error(`SIGNAL_REF_SEED_SPECS is missing the ${key} entry`);
  }
  return spec;
}

function specExpectation(spec: SignalRefSeedSpec): SignalRefSeedExpectation {
  return {
    relationKind: spec.relationKind,
    initialStrength: spec.initialStrength,
    governanceClass: spec.governanceClass,
    recallBiasSign: spec.recallBiasSign,
    recallBiasMagnitude: spec.recallBiasMagnitude,
    evidenceBasis: [...spec.evidenceBasis]
  };
}

function profileExpectation(profile: PathSeedProfile): SignalRefSeedExpectation {
  return {
    relationKind: profile.relationKind,
    initialStrength: profile.initialStrength,
    governanceClass: profile.governanceClass,
    recallBiasSign: profile.recallBiasSign,
    recallBiasMagnitude: profile.recallBiasMagnitude,
    evidenceBasis: [...profile.evidenceBasis]
  };
}

describe("signal-ref live seed table (trust-tiered)", () => {
  it("source_memory_refs stays value-equivalent to DERIVES_FROM_SEED_PROFILE", () => {
    expect(specExpectation(specByKey("source_memory_refs"))).toEqual(
      profileExpectation(DERIVES_FROM_SEED_PROFILE)
    );
  });

  it("exception_to_refs keeps the recall-neutral marker (sign 0 / magnitude 0) but downgrades governance to attention_only", () => {
    const spec = specByKey("exception_to_refs");
    // recall-neutral semantics preserved: same relation_kind, evidence,
    // strength, and the exactly-0 recall bias as the core profile.
    expect(spec.relationKind).toBe(EXCEPTION_TO_SEED_PROFILE.relationKind);
    expect(spec.initialStrength).toBe(EXCEPTION_TO_SEED_PROFILE.initialStrength);
    expect([...spec.evidenceBasis]).toEqual([...EXCEPTION_TO_SEED_PROFILE.evidenceBasis]);
    expect(spec.recallBiasSign).toBe(0);
    expect(spec.recallBiasMagnitude).toBe(0);
    // but the agent-asserted ref deliberately diverges on governance: it is
    // attacker-controllable, so it is NOT born recall_allowed like the core
    // profile. It earns governance through plasticity.
    expect(spec.governanceClass).toBe("attention_only");
    expect(spec.governanceClass).not.toBe(EXCEPTION_TO_SEED_PROFILE.governanceClass);
    expect(EXCEPTION_TO_SEED_PROFILE.governanceClass).toBe("recall_allowed");
  });

  it("agent-asserted negative refs seed weak attention_only, never recall_allowed/0.9", () => {
    for (const key of [
      "supersedes_refs",
      "contradicts_refs",
      "incompatible_with_refs"
    ] as const) {
      const spec = specByKey(key);
      // negative family: recall_bias sign preserved so plasticity still
      // classifies it correctly.
      expect(spec.recallBiasSign).toBe(-1);
      // but the seed is WEAK — not the recall_allowed/0.9 band.
      expect(spec.governanceClass).toBe("attention_only");
      expect(spec.initialStrength).toBe(0.5);
      expect(spec.governanceClass).not.toBe("recall_allowed");
      expect(spec.initialStrength).toBeLessThan(0.9);
    }
  });

  it("each negative ref keeps its family-correct recall_bias magnitude", () => {
    expect(specByKey("supersedes_refs").recallBiasMagnitude).toBe(0.5);
    expect(specByKey("contradicts_refs").recallBiasMagnitude).toBe(0.4);
    expect(specByKey("incompatible_with_refs").recallBiasMagnitude).toBe(0.3);
  });
});
