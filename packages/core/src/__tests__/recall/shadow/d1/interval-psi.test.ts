import { afterEach, describe, expect, it } from "vitest";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../../../config/install-core-config.js";
import { buildDefaultPolicy } from "../../../../recall/runtime/orchestration.js";
import {
  candidateOf,
  emptySupplementary,
  stripLive,
  truncatedReceipt
} from "../../runtime/diagnostics/lexical-bound-proof-fixture.js";
import * as shadowIndex from "../../../../recall/shadow/index.js";
import { buildLiveObservationField } from
  "../../../../recall/shadow/observe/live-observations.js";
import {
  d1PsiOutcome,
  d1PsiPredicate,
  d1PsiQ
} from "../../../../recall/shadow/d1/index.js";
import { psiPredicate, psiQ } from "../../../../recall/shadow/psi.js";
import {
  field,
  lexicalAt,
  temporalObserved,
  view
} from "../psi-test-support.js";
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

  it("keeps a non-admitted producer-observed point comparable", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "p3", ordinal: 4, admitted: false }],
          universeKeys: ["p3", "miss"]
        }
      }
    });
    const obs = missingLexical(["p3", "miss"]);
    expect(d1PsiPredicate(obs, LEX, [proof])("p3", "miss")).toBe(true);
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
    expect("d1PsiPredicate" in shadowIndex).toBe(false);
    expect("replayD1CaptureWalk" in shadowIndex).toBe(false);
  });
});

function missingLexical(keys: readonly string[]) {
  return field(Object.fromEntries(keys.map((key) => [
    key,
    view({ lexical: lexicalAt("not_observed") })
  ])));
}
