import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../../../../../runtime/config/install-core-config.js";
import { buildDefaultPolicy } from "../../../../../../recall/runtime/orchestration.js";
import {
  candidateOf,
  emptySupplementary,
  stripLive,
  truncatedReceipt
} from "../../../../runtime/diagnostics/lexical-bound-proof-fixture.js";
import { buildLiveObservationField } from
  "../../../../../../recall/integration/shadow/live-observations.js";
import {
  d1PsiOutcome,
  d1PsiPredicate,
  d1PsiQ
} from "../../../../../../recall/decision/query-proof/adapters/lexical-bound/index.js";
import { psiPredicate, psiQ } from "../../../../../../recall/decision/query-proof/psi.js";
import {
  field,
  lexicalAt,
  temporalObserved,
  view
} from "../../psi-test-support.js";
import { plantProof } from "./d1-proof-fixture.js";

const LEX = ["lexical"] as const;
const LEX_TEMP = ["lexical", "temporal"] as const;

afterEach(() => resetCoreConfigForTests());

describe("d1 pair Psi", () => {
  it("forms interval-safe gt and eq on the same LexDomain", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "hit", ordinal: 5 }, { key: "peer", ordinal: 5 }],
          universeKeys: ["hit", "miss", "peer"]
        }
      }
    });
    const obs = missingLexical(["hit", "miss", "peer"]);
    const psi = d1PsiPredicate(obs, LEX, [proof]);
    expect(psi("hit", "miss")).toBe(true);
    expect(psi("miss", "hit")).toBe(false);
    expect(d1PsiOutcome("hit", "peer", obs, LEX, [proof]).kind).toBe("equal");
    expect(psi("hit", "peer")).toBe(false);
  });

  it("skips when both lexical observations stay inapplicable", () => {
    const proof = plantProof({
      lanes: {
        exact: { tokensRouted: false },
        porter: { tokensRouted: false },
        trigram: { tokensRouted: false },
        object_key_porter: { tokensRouted: false },
        object_key_trigram: { tokensRouted: false }
      }
    });
    const obs = missingLexical(["v", "u"]);
    expect(d1PsiOutcome("v", "u", obs, LEX, [proof]).kind).toBe("skip");
    expect(d1PsiPredicate(obs, LEX, [proof])("v", "u")).toBe(false);
  });

  it("blocks overlapping lexical intervals even if another channel is gt", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "hit", ordinal: 3 }],
          limit: 1,
          universeKeys: ["hit", "miss"]
        }
      }
    });
    const obs = field({
      hit: view({
        lexical: lexicalAt("not_observed"),
        temporal: temporalObserved(0.9)
      }),
      miss: view({
        lexical: lexicalAt("not_observed"),
        temporal: temporalObserved(0.1)
      })
    });
    expect(psiQ("hit", "miss", obs, LEX_TEMP)).toBe(true);
    expect(d1PsiQ("hit", "miss", obs, LEX_TEMP, [proof])).toBe(false);
    expect(d1PsiOutcome("hit", "miss", obs, LEX_TEMP, [proof]).kind).toBe("blocked");
  });

  it("compares a producer-observed point against a missing_rank peer", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "p3", ordinal: 4, admitted: false }],
          universeKeys: ["p3", "miss"]
        }
      }
    });
    const obs = missingLexical(["p3", "miss"]);
    expect(obs.p3?.lineages.lexical?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_rank"
    });
    expect(obs.miss?.lineages.lexical?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_rank"
    });
    expect(d1PsiQ("p3", "miss", obs, LEX, [proof])).toBe(true);
    expect(d1PsiPredicate(obs, LEX, [proof])("p3", "miss")).toBe(true);
    const fieldP3 = "workspace_local:memory_entry:p3";
    const fieldMiss = "workspace_local:memory_entry:miss";
    const fieldObs = missingLexical([fieldP3, fieldMiss]);
    expect(d1PsiQ(fieldP3, fieldMiss, fieldObs, LEX, [proof])).toBe(true);
  });

  it("skips lexical comparison when no proofs are supplied", () => {
    const obs = missingLexical(["hit", "miss"]);
    expect(d1PsiOutcome("hit", "miss", obs, LEX, []).kind).toBe("skip");
    expect(d1PsiQ("hit", "miss", obs, LEX, [])).toBe(false);
  });

  it("lets a dual-prefix skip identity keep the other identity's gt", () => {
    const comparable = {
      ...noTokensLanes(),
      porter: {
        rows: [{ key: "hit", ordinal: 5 }],
        universeKeys: ["hit", "miss"]
      }
    };
    const relaxed = plantProof({ fieldPrefix: "lexical_relaxed", lanes: comparable });
    const expanded = plantProof({ fieldPrefix: "lexical_expanded", lanes: noTokensLanes() });
    const obs = missingLexical(["hit", "miss"]);
    const proofs = [relaxed, expanded];
    expect(d1PsiQ("hit", "miss", obs, LEX, proofs)).toBe(true);
    expect(d1PsiOutcome("hit", "miss", obs, LEX, proofs).kind).toBe("dominates");
    expect(d1PsiPredicate(obs, LEX, proofs)("hit", "miss")).toBe(true);
  });

  it("dominates complete absence using memory_entry field keys", () => {
    const comparable = {
      ...noTokensLanes(),
      porter: {
        rows: [{ key: "hit", ordinal: 5 }],
        universeKeys: ["hit", "miss"]
      }
    };
    const relaxed = plantProof({ fieldPrefix: "lexical_relaxed", lanes: comparable });
    const expanded = plantProof({ fieldPrefix: "lexical_expanded", lanes: comparable });
    const hit = "workspace_local:memory_entry:hit";
    const miss = "workspace_local:memory_entry:miss";
    const obs = missingLexical([hit, miss]);
    const proofs = [relaxed, expanded];
    expect(d1PsiQ(hit, miss, obs, LEX, proofs)).toBe(true);
    expect(d1PsiOutcome(hit, miss, obs, LEX, proofs).kind).toBe("dominates");
  });

  it("is incomparable across lanes and field prefixes", () => {
    const exact = plantProof({
      lanes: { exact: { rows: [{ key: "hit", ordinal: 1 }], universeKeys: ["hit"] } }
    });
    const porter = plantProof({
      lanes: { porter: { rows: [{ key: "other", ordinal: 5 }], universeKeys: ["other"] } }
    });
    const mixed = [exact, porter];
    const obs = missingLexical(["hit", "other"]);
    expect(d1PsiOutcome("hit", "other", obs, LEX, mixed).kind).toBe("blocked");
    const relaxed = plantProof({
      fieldPrefix: "lexical_relaxed",
      lanes: { porter: { rows: [{ key: "hit", ordinal: 5 }], universeKeys: ["hit"] } }
    });
    const expanded = plantProof({
      fieldPrefix: "lexical_expanded",
      lanes: { porter: { rows: [{ key: "other", ordinal: 1 }], universeKeys: ["other"] } }
    });
    expect(d1PsiOutcome("hit", "other", missingLexical(["hit", "other"]), LEX, [
      relaxed,
      expanded
    ]).kind).toBe("blocked");
  });

  it("reuses production cmpChannel for non-lexical applicable channels", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "A", ordinal: 5 }, { key: "B", ordinal: 5 }],
          universeKeys: ["A", "B"]
        }
      }
    });
    const obs = field({
      A: view({
        lexical: lexicalAt("not_observed"),
        temporal: temporalObserved(0.9)
      }),
      B: view({
        lexical: lexicalAt("not_observed"),
        temporal: temporalObserved(0.1)
      })
    });
    expect(d1PsiPredicate(obs, LEX_TEMP, [proof])("A", "B")).toBe(true);
    expect(psiPredicate(obs, ["temporal"])("A", "B")).toBe(true);
  });

  it("keeps production liveLexical missing_rank for a non-admitted candidate", () => {
    installCoreConfigFromProcessEnv();
    const receipt = truncatedReceipt();
    const field = buildLiveObservationField({
      candidates: [candidateOf("p3")],
      policy: buildDefaultPolicy({
        strategy: "chat",
        taskSurfaceRef: "d1-live-lexical",
        now: () => "2026-07-12T00:00:00.000Z",
        generateRuntimeId: () => "11111111-1111-4111-8111-111111111111"
      }),
      supplementaryData: emptySupplementary("stable"),
      memoryLexicalCaptures: [stripLive(receipt)]
    });
    expect(field["workspace_local:memory_entry:p3"]?.lineages.lexical?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_rank"
    });
  });

  it("does not grow a prefix-capture or query-proof mega-barrel", () => {
    const srcRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
    expect(existsSync(join(srcRoot, "recall/decision/prefix-capture/index.ts"))).toBe(false);
    expect(existsSync(join(srcRoot, "recall/decision/query-proof/index.ts"))).toBe(false);
  });
});

function missingLexical(keys: readonly string[]) {
  return field(Object.fromEntries(keys.map((key) => [
    key,
    view({ lexical: lexicalAt("not_observed") })
  ])));
}

function noTokensLanes() {
  return {
    exact: { tokensRouted: false as const },
    porter: { tokensRouted: false as const },
    trigram: { tokensRouted: false as const },
    object_key_porter: { tokensRouted: false as const },
    object_key_trigram: { tokensRouted: false as const }
  };
}
