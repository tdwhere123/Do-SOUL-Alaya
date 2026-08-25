import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseFrontierReceipt,
  SHADOW_FRONTIER_OPERATOR_ID,
  ShadowContractError
} from "../../../recall/shadow/index.js";
import {
  isPsiCycleFailure,
  peelUndominated
} from "../../../recall/shadow/frontier-peel.js";
import {
  eligibleCandidateKeys,
  psiPredicate,
  psiQ
} from "../../../recall/shadow/psi.js";
import {
  embeddingObserved,
  field,
  temporalObserved,
  transitivityField,
  view
} from "./psi-test-support.js";

const TEMP_EMB = ["temporal", "embedding"] as const;
const SHADOW_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../recall/shadow"
);

describe("peelUndominated D0 §5", () => {
  it("D0-F09 peels a transitive chain into structural layers", () => {
    const obs = transitivityField();
    const receipt = peelUndominated(
      eligibleCandidateKeys(obs),
      psiPredicate(obs, TEMP_EMB)
    );
    expect(isPsiCycleFailure(receipt)).toBe(false);
    if (isPsiCycleFailure(receipt)) return;
    expect(receipt.operator_id).toBe(SHADOW_FRONTIER_OPERATOR_ID);
    expect(receipt.layers.map((layer) => ({
      index: layer.index,
      member_keys: [...layer.member_keys]
    }))).toEqual([
      { index: 1, member_keys: ["A"] },
      { index: 2, member_keys: ["B"] },
      { index: 3, member_keys: ["C"] }
    ]);
    expect(receipt.layers.every((layer) =>
      !("score" in layer) && !("gain" in layer) && !("FrontierPriority" in layer)
    )).toBe(true);
  });

  it("D0-F10 cycle fails closed with no SCC", () => {
    const cyclic = (v: string, u: string) =>
      (v === "A" && u === "B") || (v === "B" && u === "C") || (v === "C" && u === "A");
    const result = peelUndominated(["A", "B", "C"], cyclic);
    expect(result).toEqual({ kind: "psi_cycle_contract_failure" });
    expect(isPsiCycleFailure(result)).toBe(true);
    expect("layers" in result).toBe(false);
  });

  it("legal trade-off is not a cycle", () => {
    const obs = field({
      A: view({
        temporal: temporalObserved(0.9),
        embedding: embeddingObserved(0.1)
      }),
      B: view({
        temporal: temporalObserved(0.1),
        embedding: embeddingObserved(0.9)
      })
    });
    expect(psiQ("A", "B", obs, TEMP_EMB)).toBe(false);
    expect(psiQ("B", "A", obs, TEMP_EMB)).toBe(false);
    const receipt = peelUndominated(["B", "A"], psiPredicate(obs, TEMP_EMB));
    expect(isPsiCycleFailure(receipt)).toBe(false);
    if (isPsiCycleFailure(receipt)) return;
    expect(receipt.layers).toEqual([
      { index: 1, member_keys: ["A", "B"] }
    ]);
  });

  it("D0-F11 stable frontiers serialize members by candidate_key only", () => {
    const obs = field({
      ...transitivityField(),
      D: view({
        temporal: temporalObserved(0.95),
        embedding: embeddingObserved(0.1)
      })
    });
    const psi = psiPredicate(obs, TEMP_EMB);
    const first = peelUndominated(["C", "D", "B", "A"], psi);
    const second = peelUndominated(["A", "B", "C", "D"], psi);
    expect(first).toEqual(second);
    expect(isPsiCycleFailure(first)).toBe(false);
    if (isPsiCycleFailure(first)) return;
    expect(first.layers[0]).toEqual({ index: 1, member_keys: ["A", "D"] });
    expect(first.layers[1]).toEqual({ index: 2, member_keys: ["B"] });
    expect(first.layers[2]).toEqual({ index: 3, member_keys: ["C"] });
    expect(parseFrontierReceipt(first).layers[0]?.index).toBe(1);
  });

  it("H-ineligible candidates are not on any frontier", () => {
    const obs = field({
      A: view({
        temporal: temporalObserved(0.9),
        embedding: embeddingObserved(0.8)
      }, "event"),
      B: view({
        temporal: temporalObserved(0.6),
        embedding: embeddingObserved(0.7)
      }),
      C: view({
        temporal: temporalObserved(0.3),
        embedding: embeddingObserved(0.2)
      })
    });
    expect(eligibleCandidateKeys(obs)).toEqual(["B", "C"]);
    const receipt = peelUndominated(
      eligibleCandidateKeys(obs),
      psiPredicate(obs, TEMP_EMB)
    );
    if (isPsiCycleFailure(receipt)) throw new Error("unexpected cycle");
    const members = receipt.layers.flatMap((layer) => layer.member_keys);
    expect(members).toEqual(["B", "C"]);
    expect(members).not.toContain("A");
  });

  it("empty eligible yields empty layers, not a cycle", () => {
    const receipt = peelUndominated([], () => true);
    expect(isPsiCycleFailure(receipt)).toBe(false);
    if (isPsiCycleFailure(receipt)) return;
    expect(receipt.layers).toEqual([]);
  });

  it("rejects duplicate eligible keys", () => {
    expect(() => peelUndominated(["A", "A"], () => false))
      .toThrow(ShadowContractError);
  });

  it("frontier index is structure, not a score field", () => {
    expect(() => parseFrontierReceipt({
      schema_version: 1,
      operator_id: SHADOW_FRONTIER_OPERATOR_ID,
      layers: [{ index: 1, member_keys: ["A"], score: 0.9 }]
    })).toThrow(/structure, not gain/u);
  });

  it("does not import production Select_Gamma or recover via SCC", () => {
    const src = readFileSync(join(SHADOW_DIR, "frontier-peel.ts"), "utf8");
    expect(src).not.toMatch(/selectGammaWalk/u);
    expect(src).not.toMatch(/assessSafeCandidateDominance/u);
    expect(src).not.toMatch(/scc|tarjan|condens/iu);
  });
});
