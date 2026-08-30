import { describe, expect, it } from "vitest";
import { parseCaptureDecisionReceipt } from "../../../../recall/decision/prefix-capture/receipts.js";
import {
  parseSetUtilityInput,
  type ShadowCoordinateAvailability,
  type ShadowSetUtilityInput
} from "../../../../recall/decision/prefix-capture/capture.js";
import { ShadowContractError } from "../../../../recall/decision/query-proof/envelope.js";
import {
  deterministicTailDecidedThisPick,
  isCapturedWalk,
  prefixSK,
  walkShadowCapture,
  type PsiQuery,
  type ShadowCapturedWalk,
  type ShadowCaptureWalkCandidate,
  type ShadowCaptureWalkResult
} from "../../../../recall/decision/prefix-capture/walk.js";

type PlantOpts = Readonly<{
  readonly object?: string;
  readonly cid?: string;
  readonly frontier?: number | null;
  readonly tokens?: number;
  readonly dim?: string;
  readonly values?: ReadonlyArray<Readonly<{ variable_id: string; semantic_identity: string }>>;
  readonly osf?: "composed" | "unavailable" | "no_match";
  readonly obligationAvailability?: Readonly<Record<string, ShadowCoordinateAvailability>>;
  readonly extraMatches?: ReadonlyArray<Readonly<{
    value: string;
    strength: number;
    raw: string;
    kind: "typed_query_atom" | "typed_fact_frame";
  }>>;
}>;

function psiFrom(edges: readonly (readonly [string, string])[]): PsiQuery {
  const set = new Set(edges.map(([dom, sub]) => `${dom}\0${sub}`));
  return (dom, sub) => set.has(`${dom}\0${sub}`);
}

function captured(result: ShadowCaptureWalkResult): ShadowCapturedWalk {
  expect(isCapturedWalk(result)).toBe(true);
  if (!isCapturedWalk(result)) throw new Error("expected captured walk");
  return result;
}

function plant(
  key: string,
  covers: Readonly<Record<string, number>> = {},
  opts: PlantOpts = {}
): ShadowCaptureWalkCandidate {
  const utility = facUtility(key, covers, opts);
  return {
    candidate_key: key,
    object_key: opts.object ?? key,
    token_cost: opts.tokens ?? 1,
    dimension: opts.dim ?? "mem",
    h_eligible: true,
    utility,
    static_frontier_index: opts.frontier ?? null
  };
}

function facUtility(
  key: string,
  covers: Readonly<Record<string, number>>,
  opts: PlantOpts
): ShadowSetUtilityInput {
  const objectKey = opts.object ?? key;
  const entries = Object.entries(covers);
  const obligations = entries.map(([value, strength]) => {
    const availability = opts.obligationAvailability?.[value] ?? "available";
    const blocked = availability === "unavailable" || availability === "not_observed";
    return {
      key: { kind: "entity" as const, value },
      raw_atom_ids: [`typed:${value}`],
      availability,
      cover: blocked ? 0 : strength,
      evaluated: availability === "available" || availability === "known_zero"
    };
  });
  const matches = entries.flatMap(([value, strength]) => {
    const availability = opts.obligationAvailability?.[value] ?? "available";
    if (availability !== "available" && availability !== "known_zero") return [];
    return [{
      obligation: { kind: "entity" as const, value },
      raw_atom_id: `typed:${value}`,
      attribution_kind: "typed_query_atom" as const,
      match_strength: strength
    }];
  }).concat((opts.extraMatches ?? []).map((extra) => ({
    obligation: { kind: "entity" as const, value: extra.value },
    raw_atom_id: extra.raw,
    attribution_kind: extra.kind,
    match_strength: extra.strength
  })));
  const osf = opts.values !== undefined ? "composed" : (opts.osf ?? "no_match");
  const cid = opts.cid === undefined
    ? { status: "unavailable" as const }
    : { status: "available" as const, cid: opts.cid, grounding: "gist" as const };
  const facility = obligations.length === 0
    ? "not_applicable" as const
    : obligations.every((row) => row.availability === "available")
      ? "available" as const
      : obligations.every((row) => row.availability === "unavailable")
        ? "unavailable" as const
        : "partially_unavailable" as const;
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: key,
    object_key: objectKey,
    obligations,
    matches,
    values: osf === "composed"
      ? { status: "composed", values: [...(opts.values ?? [])] }
      : { status: osf, values: [] },
    cid,
    availability: {
      facility,
      values: osf,
      evidence_identity: cid.status
    }
  });
}

function walk(
  candidates: readonly ShadowCaptureWalkCandidate[],
  psi: PsiQuery,
  extra: Omit<Parameters<typeof walkShadowCapture>[0], "candidates" | "psi"> = {
    token_budget: 10_000,
    per_dimension_limits: null
  }
): ShadowCapturedWalk {
  return captured(walkShadowCapture({
    candidates,
    psi,
    token_budget: extra.token_budget,
    per_dimension_limits: extra.per_dimension_limits ?? null,
    unresolved_tradeoff: extra.unresolved_tradeoff
  }));
}

describe("shadow lexicographic capture walk", () => {
  it("selects strict-G cross-frontier novelty and names the witness", () => {
    const result = walk([
      plant("A", { a1: 0.5, a2: 0 }, { cid: "gist:A", frontier: 1 }),
      plant("B", { a1: 0, a2: 1 }, { cid: "gist:B", frontier: 2 })
    ], psiFrom([["A", "B"]]));
    expect(result.S_infty).toEqual(["B", "A"]);
    expect(result.decisions[0]).toMatchObject({
      candidate_key: "B",
      capture_reason: "cross_frontier_novelty",
      G: { unscaled_remainder: 1, Values_v: 0, evidence_novelty_redundancy: 1 },
      named_novelty: { facility_keys: ["entity:a2"] },
      static_frontier_index: 2
    });
    expect(result.decisions[0]?.G).not.toHaveProperty("FrontierPriority");
    expect(parseCaptureDecisionReceipt(result.decisions[0]!)).toEqual(result.decisions[0]);
  });

  it("guards equal-G two-level dominance before candidate_key serialization", () => {
    const result = walk([
      plant("A", { a1: 0.5, a2: 0 }, { cid: "gist:A", frontier: 1 }),
      plant("B", { a1: 0, a2: 0.5 }, { cid: "gist:B", frontier: 2 })
    ], psiFrom([["A", "B"]]));
    expect(result.S_infty[0]).toBe("A");
    expect(result.decisions[0]).toMatchObject({
      capture_reason: "core_undominated",
      max_g_cohort: ["A", "B"],
      equal_g_dominance_rejects: [{ candidate_key: "B", dominated_by: "A" }],
      deterministic_tail: "origin_plane_object_id_code_unit_ascending"
    });
    expect(deterministicTailDecidedThisPick(result.decisions[0]!)).toBe(false);
  });

  it("guards equal-G three-level Psi chain so the tail cannot pick B or C", () => {
    const covers = {
      A: { a: 1, b: 0, c: 0 },
      B: { a: 0, b: 1, c: 0 },
      C: { a: 0, b: 0, c: 1 }
    } as const;
    const result = walk([
      plant("A", covers.A, { cid: "gist:A" }),
      plant("B", covers.B, { cid: "gist:B" }),
      plant("C", covers.C, { cid: "gist:C" })
    ], psiFrom([["A", "B"], ["B", "C"], ["A", "C"]]));
    expect(result.S_infty[0]).toBe("A");
    expect(result.decisions[0]).toMatchObject({
      max_g_cohort: ["A", "B", "C"],
      equal_g_dominance_rejects: [
        { candidate_key: "B", dominated_by: "A" },
        { candidate_key: "C", dominated_by: "A" }
      ]
    });
  });

  it("keeps lower-frontier members out of C when they lack exclusive novelty", () => {
    const result = walk([
      plant("A", { a1: 1 }, { cid: "gist:same", frontier: 1 }),
      plant("B", { a1: 1 }, { cid: "gist:same", frontier: 2 })
    ], psiFrom([["A", "B"]]));
    expect(result.S_infty[0]).toBe("A");
    expect(result.decisions[0]?.capture_reason).toBe("core_undominated");
    expect(result.decisions[0]?.max_g_cohort).toEqual(["A"]);
    expect(Object.keys(result.decisions[0]!.G)).not.toContain("FrontierPriority");
  });

  it("recomputes G against S so a covered atom stops paying", () => {
    const result = walk([
      plant("A", { a1: 1 }, { cid: "gist:A" }),
      plant("B", { a1: 1 }, { cid: "gist:B" })
    ], psiFrom([]));
    expect(result.S_infty).toEqual(["A", "B"]);
    expect(result.decisions[0]?.G.unscaled_remainder).toBe(1);
    expect(result.decisions[1]?.G.unscaled_remainder).toBe(0);
    expect(result.decisions[1]?.G.evidence_novelty_redundancy).toBe(1);
  });

  it("truncates one walk prefix through and beyond exhaustion", () => {
    const result = walk([
      plant("A", { a: 1 }, { cid: "gist:A" }),
      plant("B", { b: 0.8 }, { cid: "gist:B" }),
      plant("C", { c: 0.6 }, { cid: "gist:C" })
    ], psiFrom([]));
    const s = result.S_infty;
    expect(s).toEqual(["A", "B", "C"]);
    expect(prefixSK(s, 1)).toEqual(["A"]);
    expect(prefixSK(s, 2)).toEqual(["A", "B"]);
    expect(prefixSK(s, 3)).toEqual(["A", "B", "C"]);
    expect(prefixSK(s, 4)).toEqual(["A", "B", "C"]);
    expect(prefixSK(s, 3)).toEqual(prefixSK(s, 4));
    const tight = walk([
      plant("A", { a: 1 }, { cid: "gist:A", tokens: 5 }),
      plant("B", { b: 0.8 }, { cid: "gist:B", tokens: 5 })
    ], psiFrom([]), { token_budget: 5, per_dimension_limits: null });
    expect(tight.S_infty).toEqual(["A"]);
    expect(prefixSK(tight.S_infty, 1)).toEqual(prefixSK(tight.S_infty, 2));
    expect(tight.walk_rejects).toEqual([{ candidate_key: "B", walk_reject: "max_total_tokens" }]);
  });

  it("omits object kind from the equal-G tail so membership stays kindful", () => {
    const origin = "workspace_local";
    const memoryKind = "memory_entry";
    const capsuleKind = "evidence_capsule";
    const earlyId = "aaa";
    const lateId = "zzz";
    const memoryEarly = `${origin}:${memoryKind}:${earlyId}`;
    const capsuleLate = `${origin}:${capsuleKind}:${lateId}`;
    const memoryLate = `${origin}:${memoryKind}:${lateId}`;
    const capsuleEarly = `${origin}:${capsuleKind}:${earlyId}`;
    expect(capsuleLate < memoryEarly).toBe(true);
    expect(capsuleEarly < memoryLate).toBe(true);
    expect(`${origin}:${earlyId}` < `${origin}:${lateId}`).toBe(true);

    const memoryWins = walk([
      plant(capsuleLate, { capsule: 1 }, { cid: "gist:capsule-late" }),
      plant(memoryEarly, { memory: 1 }, { cid: "gist:memory-early" })
    ], psiFrom([]));
    expect(memoryWins.S_infty[0]).toBe(memoryEarly);
    expect(memoryWins.S_infty).toEqual([memoryEarly, capsuleLate]);
    expect(memoryWins.S_infty.every((key) =>
      key.includes(`:${memoryKind}:`) || key.includes(`:${capsuleKind}:`)
    )).toBe(true);
    expect(memoryWins.decisions[0]).toMatchObject({
      max_g_cohort: [capsuleLate, memoryEarly].sort(),
      equal_g_dominance_rejects: [],
      deterministic_tail: "origin_plane_object_id_code_unit_ascending"
    });
    expect(deterministicTailDecidedThisPick(memoryWins.decisions[0]!)).toBe(true);

    const capsuleWins = walk([
      plant(memoryLate, { memory: 1 }, { cid: "gist:memory-late" }),
      plant(capsuleEarly, { capsule: 1 }, { cid: "gist:capsule-early" })
    ], psiFrom([]));
    expect(capsuleWins.S_infty[0]).toBe(capsuleEarly);
    expect(capsuleWins.S_infty).toEqual([capsuleEarly, memoryLate]);
    expect(capsuleWins.S_infty.every((key) =>
      key.includes(`:${memoryKind}:`) || key.includes(`:${capsuleKind}:`)
    )).toBe(true);
  });

  it("fails closed when equal-G tail keys collide across kinds", () => {
    const origin = "workspace_local";
    const objectId = "shared";
    const memoryKey = `${origin}:memory_entry:${objectId}`;
    const capsuleKey = `${origin}:evidence_capsule:${objectId}`;
    expect(memoryKey).toBe("workspace_local:memory_entry:shared");
    expect(capsuleKey).toBe("workspace_local:evidence_capsule:shared");
    expect(memoryKey.includes(":memory_entry:")).toBe(true);
    expect(capsuleKey.includes(":evidence_capsule:")).toBe(true);

    const memory = plant(memoryKey, { memory: 1 }, { cid: "gist:memory" });
    const capsule = plant(capsuleKey, { capsule: 1 }, { cid: "gist:capsule" });
    const collide = (
      candidates: readonly ShadowCaptureWalkCandidate[]
    ) => walkShadowCapture({
      candidates,
      psi: psiFrom([]),
      token_budget: 10_000,
      per_dimension_limits: null
    });

    const memoryFirst = () => collide([memory, capsule]);
    const capsuleFirst = () => collide([capsule, memory]);
    expect(memoryFirst).toThrow(ShadowContractError);
    expect(capsuleFirst).toThrow(ShadowContractError);
    expect(memoryFirst).toThrow(/equal-G tail key collision/u);
    expect(capsuleFirst).toThrow(/equal-G tail key collision/u);
  });

  it("serializes heterogeneous equal-G trade-offs by candidate_key only", () => {
    const tradeoff = (left: string, right: string) =>
      (left === "A" && right === "B") || (left === "B" && right === "A");
    const strict = walk([
      plant("A", { a1: 1 }, { cid: "gist:A" }),
      plant("B", {}, { cid: "gist:B" })
    ], psiFrom([]), {
      token_budget: 10_000,
      per_dimension_limits: null,
      unresolved_tradeoff: tradeoff
    });
    expect(strict.S_infty[0]).toBe("A");
    expect(strict.decisions[0]?.unresolved_pointwise_tradeoff).toBe(false);
    const equal = walk([
      plant("A", { a1: 1 }, { cid: "gist:A" }),
      plant("B", { b1: 1 }, { cid: "gist:B" })
    ], psiFrom([]), {
      token_budget: 10_000,
      per_dimension_limits: null,
      unresolved_tradeoff: tradeoff
    });
    expect(equal.S_infty[0]).toBe("A");
    expect(equal.decisions[0]).toMatchObject({
      max_g_cohort: ["A", "B"],
      equal_g_dominance_rejects: [],
      unresolved_pointwise_tradeoff: true,
      deterministic_tail: "origin_plane_object_id_code_unit_ascending"
    });
    expect(deterministicTailDecidedThisPick(equal.decisions[0]!)).toBe(true);
  });

  it.each([
    ["facility", plant("A", { a: 0 }, {
      cid: "gist:A",
      obligationAvailability: { a: "unavailable" }
    }), plant("B", { a: 1 }, { cid: "gist:B" })],
    ["values", plant("A", {}, { cid: "gist:A", osf: "unavailable" }), plant("B", {}, {
      cid: "gist:B",
      values: [{ variable_id: "v", semantic_identity: "s" }]
    })],
    ["evidence", plant("A", {}, { osf: "no_match" }), plant("B", {}, { cid: "gist:B" })]
  ] as const)("rejects Core-unavailable %s exclusivity", (_kind, core, lower) => {
    const result = walk([core, lower], psiFrom([["A", "B"]]));
    expect(result.S_infty[0]).toBe("A");
    expect(result.decisions[0]?.capture_reason).toBe("core_undominated");
    expect(result.decisions[0]?.max_g_cohort).toEqual(["A"]);
  });

  it("counts correlated aliases once in capture G", () => {
    const result = walk([
      plant("A", { alice: 0.4 }, {
        cid: "gist:A",
        extraMatches: [{
          value: "alice",
          strength: 0.2,
          raw: "frame:alice",
          kind: "typed_fact_frame"
        }]
      }),
      plant("B", { bob: 0.3 }, { cid: "gist:B" })
    ], psiFrom([]));
    expect(result.decisions[0]?.G.unscaled_remainder).toBe(0.4);
    expect(result.S_infty[0]).toBe("A");
  });

  it("fails closed when Core is empty", () => {
    const result = walkShadowCapture({
      candidates: [
        plant("A", { a: 1 }, { cid: "gist:A" }),
        plant("B", { b: 1 }, { cid: "gist:B" }),
        plant("C", { c: 1 }, { cid: "gist:C" })
      ],
      psi: psiFrom([["A", "B"], ["B", "C"], ["C", "A"]]),
      token_budget: 10_000,
      per_dimension_limits: null
    });
    expect(result).toEqual({ kind: "psi_cycle_contract_failure" });
  });

  it("treats object-key collision as a walk reject, not H", () => {
    const result = walk([
      plant("A", { a: 1 }, { cid: "gist:A", object: "obj" }),
      plant("B", { b: 0.5 }, { cid: "gist:B", object: "obj" })
    ], psiFrom([]));
    expect(result.S_infty).toEqual(["A"]);
    expect(result.walk_rejects).toEqual([
      { candidate_key: "B", walk_reject: "duplicate_object" }
    ]);
  });

  it("does not import or consult Select_Gamma", async () => {
    const walkSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../../../recall/decision/prefix-capture/walk.ts", import.meta.url), "utf8")
    );
    const gammaSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../../../recall/decision/prefix-capture/gamma-tuple.ts", import.meta.url), "utf8")
    );
    expect(walkSource).not.toMatch(/selectGammaWalk/u);
    expect(gammaSource).not.toMatch(/selectGammaWalk/u);
    expect(walkSource).not.toMatch(/fused_score|FrontierPriority/u);
    expect(gammaSource).not.toMatch(/fused_score|FrontierPriority/u);
  });
});
