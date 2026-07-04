import { describe, expect, it } from "vitest";
import {
  ManifestationState,
  PathGovernanceClass,
  type ManifestationState as ManifestationStateValue,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  GOVERNANCE_CEILING_FAILSAFE_BAND,
  clampManifestationByGovernance,
  memoryGovernanceCeiling} from "../../path-graph/path-relations/path-manifestation-policy.js";

describe("memoryGovernanceCeiling — governance HARD CEILING band mapping", () => {
  // Helper: a contribution with a TRUSTED recall_allowed-birth provenance marker
  // (signal-graph seed). Non-recall_allowed bands ignore evidence_basis.
  function band(
    governance_class: PathRelation["legitimacy"]["governance_class"]
  ): { governance_class: typeof governance_class; evidence_basis: readonly string[] } {
    return { governance_class, evidence_basis: ["signal_graph_reference"] };
  }
  // Helper: an UNTRUSTED recall_allowed contribution — the band a co-usage/
  // supports/derives path reaches via the agent-pumpable auto-promotion ladder.
  // evidence_basis still carries only its BIRTH marker (plasticity rewrites
  // governance_class but never evidence_basis).
  function pumpedRecallAllowed(birthMarker: string): {
    governance_class: "recall_allowed";
    evidence_basis: readonly string[];
  } {
    return { governance_class: "recall_allowed", evidence_basis: [birthMarker] };
  }

  it("maps each band to its most-permissive ManifestationState ceiling", () => {
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.HINT_ONLY)])).toBe(
      ManifestationState.HINT
    );
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.ATTENTION_ONLY)])).toBe(
      ManifestationState.EXCERPT
    );
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.RECALL_ALLOWED)])).toBe(
      ManifestationState.FULL_ELIGIBLE
    );
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.STRICTLY_GOVERNED)])).toBe(
      ManifestationState.FULL_ELIGIBLE
    );
  });

  it("empty contribution set (no governing inbound path) defaults to full_eligible (unrestricted)", () => {
    expect(memoryGovernanceCeiling([])).toBe(ManifestationState.FULL_ELIGIBLE);
  });

  it("reduces multiple inbound bands to the MOST PERMISSIVE — strong assoc not throttled by weak", () => {
    // A memory governed by BOTH a hint_only and a (trusted) recall_allowed
    // inbound path takes the full_eligible ceiling: a strong association must
    // not be capped by a weak co-existing one.
    expect(
      memoryGovernanceCeiling([
        band(PathGovernanceClass.HINT_ONLY),
        band(PathGovernanceClass.RECALL_ALLOWED)
      ])
    ).toBe(ManifestationState.FULL_ELIGIBLE);
    // hint_only + attention_only -> excerpt (the more permissive of the two).
    expect(
      memoryGovernanceCeiling([
        band(PathGovernanceClass.HINT_ONLY),
        band(PathGovernanceClass.ATTENTION_ONLY)
      ])
    ).toBe(ManifestationState.EXCERPT);
    // Order independence.
    expect(
      memoryGovernanceCeiling([
        band(PathGovernanceClass.RECALL_ALLOWED),
        band(PathGovernanceClass.HINT_ONLY)
      ])
    ).toBe(ManifestationState.FULL_ELIGIBLE);
  });

  describe("Finding #2 — ceiling does not ride the agent-pumpable governance band", () => {
    it.each([
      ["recalls_edge_co_usage"],
      ["llm_supports_inference"],
      ["llm_derives_inference"],
      ["shared_entity_overlap"]
    ])(
      "an auto-promoted recall_allowed (birth marker %s, no trusted provenance) caps at excerpt",
      (birthMarker) => {
        // A positive co-usage/supports/derives/shares_entity path that climbed
        // to recall_allowed by pumping support_events_count >= 8 keeps only its
        // birth evidence_basis — it must NOT lift the ceiling to full_eligible.
        expect(memoryGovernanceCeiling([pumpedRecallAllowed(birthMarker)])).toBe(
          ManifestationState.EXCERPT
        );
      }
    );

    it("a trusted-seed recall_allowed (signal_graph_reference) reaches full_eligible", () => {
      expect(
        memoryGovernanceCeiling([
          { governance_class: "recall_allowed", evidence_basis: ["signal_graph_reference"] }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });

    it("a human/auto edge-accept recall_allowed (edge_proposal_accept:<id>) reaches full_eligible", () => {
      expect(
        memoryGovernanceCeiling([
          {
            governance_class: "recall_allowed",
            evidence_basis: ["edge_proposal_accept:edge_prop_abc123"]
          }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });

    it("strictly_governed (user-set, not auto-reachable) reaches full_eligible regardless of evidence", () => {
      expect(
        memoryGovernanceCeiling([
          { governance_class: "strictly_governed", evidence_basis: ["anything"] }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });

    it("a pumped recall_allowed co-existing with a trusted one still reaches full_eligible (most-permissive)", () => {
      // The trust narrowing is per-contribution: a legitimate trusted path is
      // not penalised by a pumped sibling, and a pumped path cannot exceed
      // excerpt on its own.
      expect(
        memoryGovernanceCeiling([
          pumpedRecallAllowed("recalls_edge_co_usage"),
          { governance_class: "recall_allowed", evidence_basis: ["signal_graph_reference"] }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });
  });
});

describe("clampManifestationByGovernance — pure total min over the strict ordering", () => {
  const order: readonly ManifestationStateValue[] = [
    ManifestationState.HIDDEN,
    ManifestationState.HINT,
    ManifestationState.EXCERPT,
    ManifestationState.FULL_ELIGIBLE
  ];

  it("returns the LOWER band for the full tier x ceiling grid", () => {
    for (const tier of order) {
      for (const ceiling of order) {
        const tierRank = order.indexOf(tier);
        const ceilingRank = order.indexOf(ceiling);
        const expected = tierRank <= ceilingRank ? tier : ceiling;
        expect(clampManifestationByGovernance(tier, ceiling)).toBe(expected);
      }
    }
  });

  it("never elevates: a hidden tier with a full_eligible ceiling stays hidden", () => {
    expect(
      clampManifestationByGovernance(ManifestationState.HIDDEN, ManifestationState.FULL_ELIGIBLE)
    ).toBe(ManifestationState.HIDDEN);
  });

  it("caps: a full_eligible tier with a hint ceiling drops to hint", () => {
    expect(
      clampManifestationByGovernance(ManifestationState.FULL_ELIGIBLE, ManifestationState.HINT)
    ).toBe(ManifestationState.HINT);
  });
});

describe("GOVERNANCE_CEILING_FAILSAFE_BAND — fail-closed to the lowest visibility band", () => {
  it("is HINT, the only band that is never an over-surface for ANY governance class", () => {
    // A transient governance-read failure must cap to the LOWEST non-hidden band.
    // hint is the only band <= every governance class's true ceiling: hint_only
    // (hint), attention_only (excerpt), recall_allowed (full_eligible), and
    // strictly_governed (full_eligible) all permit at least hint, so capping to
    // hint cannot exceed any class's true ceiling. A higher failsafe (excerpt)
    // would over-surface a hint_only memory. see also: recall-service.ts
    //   collectGovernanceCeilings (throw branch).
    expect(GOVERNANCE_CEILING_FAILSAFE_BAND).toBe(ManifestationState.HINT);
    // The failsafe band must be <= each governance class's true ceiling band, so
    // clamping to it on a read error never over-surfaces any class.
    for (const governance of [
      PathGovernanceClass.HINT_ONLY,
      PathGovernanceClass.ATTENTION_ONLY,
      PathGovernanceClass.RECALL_ALLOWED,
      PathGovernanceClass.STRICTLY_GOVERNED
    ]) {
      const trueCeiling = memoryGovernanceCeiling([
        { governance_class: governance, evidence_basis: ["signal_graph_reference"] }
      ]);
      expect(clampManifestationByGovernance(trueCeiling, GOVERNANCE_CEILING_FAILSAFE_BAND)).toBe(
        GOVERNANCE_CEILING_FAILSAFE_BAND
      );
    }
  });
});
