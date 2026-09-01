import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCaptureDecisionReceipt } from
  "../../../../../recall/decision/prefix-capture/receipts.js";
import {
  isCapturedWalk,
  prefixSK,
  walkShadowCapture,
  type ShadowCapturedWalk
} from "../../../../../recall/decision/prefix-capture/walk.js";
import { enumerateFiniteDecisionOracle } from
  "../../../../../recall/decision/query-proof/proof/oracle/oracle.js";
import {
  compareAbstractProofToOracle,
  certifyAbstractSingletonWithFiniteOracle
} from "../../../../../recall/decision/query-proof/proof/abstract/differential.js";
import {
  createChannelClosureResult,
  createScopedCompletenessReference
} from "../../../../../recall/decision/query-proof/closure/contract.js";
import { deriveLiveClosureAuthorityBinding } from
  "../../../../../recall/decision/query-proof/closure/live-authority-binding.js";
import { closeLexicalBoundChannel } from
  "../../../../../recall/decision/query-proof/closure/lexical-bound.js";
import type { FiniteOracleFixture } from
  "../../../../../recall/decision/query-proof/proof/oracle/contract.js";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";
import {
  DECISION_STABILITY_SEAL_OPERATOR_ID,
  QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
  parseDecisionStabilitySeal
} from "../../../../../recall/decision/query-proof/seal/contract.js";
import {
  captureQueryProofDecideWorld,
  digestDecideWorld,
  freezeDecideWorld,
  queryProofDecideBaseState
} from
  "../../../../../recall/decision/query-proof/seal/world-capture.js";
import { overlayWorld } from
  "../../../../../recall/decision/query-proof/seal/overlay.js";
import {
  checkDecisionStability,
  digestQueryProofState
} from "../../../../../recall/decision/query-proof/seal/checker.js";
import {
  createQueryProofAbstractOperator,
  createQueryProofDecisionOperator,
  emptyWalkUtility,
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1
} from "../../../../../recall/decision/query-proof/seal/decide.js";
import { createQueryCompiledWalkTransfer } from
  "../../../../../recall/decision/query-proof/gamma/walk-binding.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import {
  authorityFrom,
  certifiedScalarAuthority,
  cleanup,
  finiteLexicalPreparedAuthority,
  preparedAuthority,
  scalarQueryAuthority
} from "../../../integration/shadow/live-receipt-fixtures.js";
import {
  compiledGammaBodyDigest,
  type QueryGammaCompileInputV1
} from "../../../../../recall/decision/query-proof/gamma/compile.js";
import {
  SHADOW_CAPTURE_OPERATOR_ID
} from "../../../../../recall/decision/prefix-capture/identity.js";
import { previewSidecar } from
  "../../../../../recall/integration/shadow/query-proof-preview.js";

import {
  allObservableDistinct,
  binding,
  candidate,
  compileGamma,
  compileInputFor,
  compilationFor,
  distinctQuery,
  proposition,
  scalarQuery,
  sequenceQuery
} from "../gamma/gamma-fixture.js";
import {
  emptyCompleteLexicalProof,
  withIssuedSource
} from "../closure/live-lexical-source-fixture.js";
import type { CanonicalQueryV1 } from
  "../../../../../recall/query/canonical-query/index.js";
import type { QueryGammaCandidateEvidenceV1 } from
  "../../../../../recall/decision/query-proof/gamma/contract.js";

let prepared: PreparedRecallRequest;
let lexicalPrepared: PreparedRecallRequest;

beforeAll(async () => {
  [prepared, lexicalPrepared] = await Promise.all([
    preparedAuthority(),
    finiteLexicalPreparedAuthority()
  ]);
});

afterAll(() => {
  cleanup(prepared);
  cleanup(lexicalPrepared);
});

function worldOf(
  keys: readonly string[],
  compiled = compileGamma(scalarQuery(),
    keys.map((key) => candidate(key, { bindings: [binding(key)] }))),
  compileInput: QueryGammaCompileInputV1 = compileInputFor(scalarQuery(),
    keys.map((key) => candidate(key, { bindings: [binding(key)] })))
): QueryProofDecideWorldV1 {
  return Object.freeze({
    compiled,
    compile_input: compileInput,
    candidates: keys.map((key) => Object.freeze({
      candidate_key: key,
      object_key: key,
      token_cost: 1,
      dimension: "mem",
      h_eligible: true,
      utility: emptyWalkUtility(key, key),
      static_frontier_index: null
    })),
    psi_edges: Object.freeze([]),
    token_budget: 10,
    per_dimension_limits: null,
    unresolved_tradeoff_pairs: Object.freeze([]),
    answer_bindings: keys.map((key) => Object.freeze({
      candidate_key: key,
      binding_id: `bind:${key}`,
      variable: "x",
      semantic_identity: key,
      value: key
    }))
  });
}

function worldFromQuery(
  query: CanonicalQueryV1,
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  extra: Partial<QueryGammaCompileInputV1> = {},
  patch: Partial<QueryProofDecideWorldV1> = {}
): QueryProofDecideWorldV1 {
  const compileInput = compileInputFor(query, evidence, extra);
  const compiled = compileGamma(query, evidence, extra);
  const keys = evidence.map((row) => row.candidate_key);
  return Object.freeze({
    ...worldOf(keys, compiled, compileInput),
    ...patch,
    compiled,
    compile_input: compileInput
  });
}

function candidateIdentityDigest(key: string) {
  return digestRecallFieldIdentity({ candidate_key: key, object_key: key });
}

function captureEmptyWorld(
  authority: ReturnType<typeof scalarQueryAuthority>,
  bindRuntime = true
): QueryProofDecideWorldV1 {
  const world = captureQueryProofDecideWorld({
    live_authority: authority,
    premises: {
      candidates: Object.freeze([]),
      psi_edges: Object.freeze([]),
      token_budget: 10,
      per_dimension_limits: null,
      unresolved_tradeoff_pairs: Object.freeze([]),
      answer_bindings: Object.freeze([])
    }
  });
  if (bindRuntime) {
    const preview = previewSidecar({ world }, 1, { walk: runQueryProofDecideQ(world, 1).walk });
    if (preview.query_proof_preview?.status !== "captured") {
      throw new Error("captured world did not bind to its runtime manifest");
    }
  }
  return world;
}

async function withCapturedEmptyCase<T>(
  use: (value: Readonly<{
    readonly authority: ReturnType<typeof scalarQueryAuthority>;
    readonly world: QueryProofDecideWorldV1;
    readonly closure: NonNullable<ReturnType<typeof closeLexicalBoundChannel>>;
  }>) => T
): Promise<T> {
  return await withIssuedSource(
    lexicalPrepared,
    emptyCompleteLexicalProof(),
    (sourceAuthority) => {
      const scalar = scalarQueryAuthority(lexicalPrepared);
      const authority = Object.freeze({
        ...sourceAuthority,
        canonical_query_evidence: scalar.canonical_query_evidence,
        canonical_query_compilation: scalar.canonical_query_compilation
      });
      const closure = closeLexicalBoundChannel(authority);
      if (closure === null || closure.status !== "exact_closed") {
        throw new Error("expected exact empty lexical closure");
      }
      return use(Object.freeze({
        authority,
        world: captureEmptyWorld(authority),
        closure
      }));
    }
  );
}

function noFalseSingleton(
  world: QueryProofDecideWorldV1,
  fixture: FiniteOracleFixture,
  coordinates: Parameters<typeof checkDecisionStability>[0]["coordinates"]
): boolean {
  const input = checkerInput(world, fixture, coordinates);
  const kernel = {
    live_authority: input.live_authority,
    fixture,
    concrete_operator: input.concrete_operator,
    k_max: fixture.k_max,
    closures: input.closures,
    coordinates,
    limits: input.limits,
    operator: input.abstract_operator
  };
  const oracle = enumerateFiniteDecisionOracle({
    authority: input.live_authority,
    fixture,
    operator: input.concrete_operator
  });
  const proved = certifyAbstractSingletonWithFiniteOracle(kernel, oracle);
  return compareAbstractProofToOracle(kernel, proved, oracle).false_singleton;
}

function checkerInput(
  world: QueryProofDecideWorldV1,
  fixture: FiniteOracleFixture,
  coordinates: Parameters<typeof checkDecisionStability>[0]["coordinates"] = [],
  authority = authorityFrom(prepared)
) {
  return {
    live_authority: authority,
    fixture,
    compiled: world.compiled,
    world,
    concrete_operator: createQueryProofDecisionOperator(world),
    abstract_operator: createQueryProofAbstractOperator(world),
    closures: [],
    coordinates,
    limits: { max_channels: 8, max_coordinates: 16, max_sensitivities: 16 },
    k_max: fixture.k_max
  };
}

function withCompilationDigest(
  compiled: QueryProofDecideWorldV1["compiled"],
  compilationDigest: QueryProofDecideWorldV1["compiled"]["compilation_digest"]
): QueryProofDecideWorldV1["compiled"] {
  const patched = Object.freeze({
    ...compiled,
    compilation_digest: compilationDigest
  });
  return Object.freeze({
    ...patched,
    gamma_digest: compiledGammaBodyDigest(patched)
  });
}

function emptyFixture(kMax: number, world?: QueryProofDecideWorldV1): FiniteOracleFixture {
  const baseState = world === undefined ? {} : queryProofDecideBaseState(world);
  return {
    fixture_id: "query-proof-decide-empty",
    snapshot_digest: world === undefined
      ? prepared.snapshotVector.vector_digest
      : (baseState as { readonly snapshot_digest: ReturnType<typeof digestRecallFieldIdentity> })
        .snapshot_digest,
    k_max: kMax,
    base_state: baseState,
    coordinates: []
  };
}

describe("final Decide_Q and SealChecker_v1", () => {
  it("rejects caller-authored Gamma evidence for a non-empty captured world", () => {
    const authority = certifiedScalarAuthority(prepared);
    expect(() => captureQueryProofDecideWorld({
      live_authority: authority,
      premises: {
        candidates: [Object.freeze({
          candidate_key: "A",
          object_key: "A",
          token_cost: 1,
          dimension: "mem",
          h_eligible: true,
          utility: emptyWalkUtility("A", "A"),
          static_frontier_index: null
        })],
        psi_edges: [],
        token_budget: 10,
        per_dimension_limits: null,
        unresolved_tradeoff_pairs: [],
        answer_bindings: []
      }
    })).toThrow(/requires source-bound Gamma evidence/u);
  });

  it("certifies one empty trace only from its complete source-owned manifest", async () => {
    await withCapturedEmptyCase(({ authority, world, closure }) => {
      const fixture = emptyFixture(1, world);
      const omitted = checkDecisionStability(checkerInput(world, fixture, [], authority));
      expect(omitted.status).toBe("UNCERTIFIED_OPEN");
      if (omitted.status !== "UNCERTIFIED_OPEN") throw new Error("expected open manifest");
      expect(omitted.reason).toMatch(/complete source-owned closure manifest/u);
      const checker = checkDecisionStability({
        ...checkerInput(world, fixture, [], authority),
        closures: [closure]
      });
      if (checker.status !== "CERTIFIED_STABLE") throw new Error(JSON.stringify(checker));
      expect(parseDecisionStabilitySeal(checker.seal)).toEqual(checker.seal);
      expect(checker.seal.candidate_prefix).toEqual([]);
      expect(checker.seal.authority_digest)
        .toBe(deriveLiveClosureAuthorityBinding(authority).authority_digest);
    });
  });

  it("cannot bind runtime authority from an unissued or mismatched walk", () => {
    const world = captureEmptyWorld(certifiedScalarAuthority(prepared), false);
    const forged = Object.freeze({
      kind: "captured" as const,
      operator_id: SHADOW_CAPTURE_OPERATOR_ID,
      S_infty: Object.freeze([] as string[]),
      decisions: Object.freeze([]),
      walk_rejects: Object.freeze([])
    }) as ShadowCapturedWalk;
    expect(previewSidecar({ world }, 1, { walk: forged }).query_proof_preview?.status)
      .toBe("failed");

    const mismatched = walkShadowCapture({
      candidates: [Object.freeze({
        candidate_key: "other",
        object_key: "other",
        token_cost: 1,
        dimension: "mem",
        h_eligible: true,
        utility: emptyWalkUtility("other", "other"),
        static_frontier_index: null
      })],
      psi: () => false,
      token_budget: 10,
      per_dimension_limits: null
    });
    if (!isCapturedWalk(mismatched)) throw new Error("expected issued mismatched walk");
    expect(previewSidecar({ world }, 1, { walk: mismatched }).query_proof_preview?.status)
      .toBe("failed");
  });

  it("rejects runtime-bound worlds under a different authority, base state, or K", async () => {
    await withCapturedEmptyCase(({ authority, world, closure }) => {
      const fixture = emptyFixture(1, world);
      const foreign = checkDecisionStability(checkerInput(
        world,
        fixture,
        [],
        authorityFrom(prepared)
      ));
      expect(foreign.status).toBe("UNSUPPORTED");
      if (foreign.status !== "UNSUPPORTED") throw new Error("expected authority refusal");
      expect(foreign.reason).toMatch(/outside the supplied live authority/u);

      const wrongBase = checkDecisionStability({
        ...checkerInput(world, { ...fixture, base_state: Object.freeze({}) }, [], authority),
        closures: [closure]
      });
      expect(wrongBase.status).toBe("UNSUPPORTED");
      if (wrongBase.status !== "UNSUPPORTED") throw new Error("expected base refusal");
      expect(wrongBase.reason).toMatch(/base_state/u);

      expect(checkDecisionStability({
        ...checkerInput(world, fixture, [], authority),
        closures: [closure],
        k_max: 2
      }).status).toBe("UNSUPPORTED");
    });
  });

  it("binds prefixSK of one existing walk and shares the decision-contract digest", () => {
    const world = worldOf(["A", "B"]);
    const decided = runQueryProofDecideQ(world, 1);
    expect(isCapturedWalk(decided.walk)).toBe(true);
    expect(decided.prefix).toEqual(prefixSK(decided.walk.S_infty, 1));
    expect(decided.trace.pick_reasons).toHaveLength(1);
    const transfer = createQueryCompiledWalkTransfer(world.compiled);
    expect(decided.decision_contract_digest).toContain("sha256:");
    expect(transfer.kind).toBe("query_compiled_gamma");
  });

  it("enumerates the bound operator without naming a fixture Decide_Q", () => {
    const world = worldOf(["A"]);
    const operator = createQueryProofDecisionOperator(world);
    expect(operator.operator_id).toBe("query_proof_final_decision_v1");
    expect(operator.operator_id.toLowerCase().includes("decide_q")).toBe(false);
    const result = enumerateFiniteDecisionOracle({
      authority: authorityFrom(prepared),
      fixture: emptyFixture(1),
      operator
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.candidate_prefix).toEqual(["A"]);
  });

  it("certifies only a singleton prefix/binding/reason and mints a non-kernel seal", () => {
    const world = worldOf(["A"]);
    const checker = checkDecisionStability({
      live_authority: authorityFrom(prepared),
      fixture: emptyFixture(1),
      compiled: world.compiled,
      world,
      concrete_operator: createQueryProofDecisionOperator(world),
      abstract_operator: createQueryProofAbstractOperator(world),
      closures: [],
      coordinates: [],
      limits: { max_channels: 8, max_coordinates: 16, max_sensitivities: 16 },
      k_max: 1
    });
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
    const decided = runQueryProofDecideQ(world, 1);
    expect(decided.decision_contract_digest).toContain("sha256:");
    expect(decided.prefix).toEqual(["A"]);
    expect(() => parseDecisionStabilitySeal({
      operator_id: "operator_parametric_abstract_proof_kernel_v1",
      status: "PROVED_SINGLETON"
    })).toThrow(/kernel-only proof/u);
  });

  it("does not certify when refinements produce distinct bindings or reasons", () => {
    const world = worldOf(["A"]);
    const fixture: FiniteOracleFixture = {
      fixture_id: "binding-split",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [{
        coordinate_id: "bind:A",
        sensitivity_id: "sensitivity:answer",
        owner_id: "A",
        kind: "answer_binding",
        abstract_kind: "binding",
        choices: [
          { choice_id: "alpha", value: "alpha" },
          { choice_id: "beta", value: "beta" }
        ]
      }]
    };
    const checker = checkDecisionStability({
      live_authority: authorityFrom(prepared),
      fixture,
      compiled: world.compiled,
      world,
      concrete_operator: createQueryProofDecisionOperator(world),
      abstract_operator: createQueryProofAbstractOperator(world),
      closures: [],
      coordinates: [{
        coordinate_id: "bind:A",
        sensitivity_id: "sensitivity:answer",
        owner_id: "A",
        kind: "binding",
        possible_bindings: ["alpha", "beta"]
      }],
      limits: { max_channels: 8, max_coordinates: 16, max_sensitivities: 16 },
      k_max: 1
    });
    expect(checker.status).toBe("UNCERTIFIED_OPEN");
  });

  it("leaves an open identity tail uncertified", () => {
    const world = worldOf(["A"]);
    const fixture: FiniteOracleFixture = {
      fixture_id: "open-identity",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [{
        coordinate_id: "identity-tail",
        sensitivity_id: "sensitivity:identity-tail",
        owner_id: "owner:identity-tail",
        kind: "identity_tie",
        abstract_kind: "identity_tie",
        choices: [{ choice_id: "open", value: "open" }]
      }]
    };
    const checker = checkDecisionStability({
      live_authority: authorityFrom(prepared),
      fixture,
      compiled: world.compiled,
      world,
      concrete_operator: createQueryProofDecisionOperator(world),
      abstract_operator: createQueryProofAbstractOperator(world),
      closures: [],
      coordinates: [{
        coordinate_id: "identity-tail",
        sensitivity_id: "sensitivity:identity-tail",
        owner_id: "owner:identity-tail",
        kind: "identity_tie",
        universe: "open",
        possible_winner_digests: [`sha256:${"1".repeat(64)}`]
      }],
      limits: { max_channels: 8, max_coordinates: 16, max_sensitivities: 16 },
      k_max: 1
    });
    expect(checker.status).not.toBe("CERTIFIED_STABLE");
  });

  it("fails closed on tampered snapshot identity", () => {
    const world = worldOf(["A"]);
    const fixture: FiniteOracleFixture = {
      ...emptyFixture(1),
      snapshot_digest: `sha256:${"a".repeat(64)}`
    };
    const checker = checkDecisionStability({
      live_authority: authorityFrom(prepared),
      fixture,
      compiled: world.compiled,
      world,
      concrete_operator: createQueryProofDecisionOperator(world),
      abstract_operator: createQueryProofAbstractOperator(world),
      closures: [],
      coordinates: [],
      limits: { max_channels: 8, max_coordinates: 16, max_sensitivities: 16 },
      k_max: 1
    });
    expect(checker.status).toBe("UNSUPPORTED");
  });

  it("keeps compiled walk receipts parseable and free of live facility G fields", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1")]
      })
    ]);
    const walked = walkShadowCapture({
      candidates: [{
        candidate_key: "A",
        object_key: "A",
        token_cost: 1,
        dimension: "mem",
        h_eligible: true,
        utility: emptyWalkUtility("A", "A"),
        static_frontier_index: null
      }],
      psi: () => false,
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected");
    expect(parseCaptureDecisionReceipt(walked.decisions[0]!)).toEqual(walked.decisions[0]);
    expect(walked.decisions[0]?.G).not.toHaveProperty("unscaled_remainder");
    expect(walked.decisions[0]?.G).toMatchObject({ certified_independent_support: 0 });
  });

  it("keeps the third coordinate structural zero through walk, oracle, and checker", () => {
    const world = worldOf(["A"]);
    const decided = runQueryProofDecideQ(world, 1);
    expect(decided.walk.decisions[0]?.G).toEqual({
      answer_binding_position: 1,
      required_proposition_support: 0,
      certified_independent_support: 0
    });
    const oracle = enumerateFiniteDecisionOracle({
      authority: authorityFrom(prepared),
      fixture: emptyFixture(1),
      operator: createQueryProofDecisionOperator(world)
    });
    expect(oracle.outcomes).toHaveLength(1);
    const checker = checkDecisionStability(checkerInput(world, emptyFixture(1)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
    expect(decided.decision_contract_digest).toContain("sha256:");
  });

  it("does not certify unresolved semantic feasibility", () => {
    const evidence = [
      candidate("open", { bindings_status: "unknown" }),
      candidate("ok", { bindings: [binding("alice")] })
    ];
    const world = worldFromQuery(scalarQuery(), evidence);
    const decided = runQueryProofDecideQ(world, 2);
    expect(decided.prefix).toEqual(["ok"]);
    expect(decided.walk.S_infty).toEqual(["ok"]);
    const checker = checkDecisionStability(checkerInput(world, emptyFixture(1)));
    expect(checker.status).not.toBe("CERTIFIED_STABLE");
  });

  it("keeps infeasible candidates out of Decide_Q prefix and certification", () => {
    const evidence = [
      candidate("refute", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "refutes")]
      }),
      candidate("ok", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1")]
      })
    ];
    const world = worldFromQuery(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), evidence);
    const decided = runQueryProofDecideQ(world, 2);
    expect(decided.prefix).toEqual(["ok"]);
    expect(decided.walk.S_infty).not.toContain("refute");
    const checker = checkDecisionStability(checkerInput(world, emptyFixture(2)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
  });

  it("does not certify all_observable without a covering closure", () => {
    const world = worldFromQuery(allObservableDistinct(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    expect(checkDecisionStability(checkerInput(world, emptyFixture(1))).status)
      .toBe("UNCERTIFIED_OPEN");
    const live = deriveLiveClosureAuthorityBinding(authorityFrom(prepared));
    const universe = `sha256:${"7".repeat(64)}` as const;
    const scope = {
      ...live,
      query_digest: world.compiled.compilation_digest,
      observer_id: "observer:unscoped",
      channel_id: "channel:unscoped",
      domain_id: "domain:unscoped",
      universe_digest: universe
    };
    const unscoped = createChannelClosureResult({
      scope,
      status: "exact_closed",
      remaining_effects: [],
      completeness_refs: [createScopedCompletenessReference({
        scope,
        source_receipt_digest: universe,
        universe_digest: universe,
        coordinate_id: "membership"
      })],
      source_kind: "structural_only",
      source_receipt_digests: [universe],
      reason: "unscoped-all-observable"
    });
    const unscopedCheck = checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      closures: [unscoped]
    });
    expect(unscopedCheck.status).toBe("UNCERTIFIED_OPEN");
    if (unscopedCheck.status !== "UNCERTIFIED_OPEN") throw new Error("expected open");
    expect(unscopedCheck.reason).toMatch(/seal obligations/u);
  });

  it("does not certify an unresolved trade-off at a selected boundary", () => {
    const world = worldFromQuery(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ], {}, { unresolved_tradeoff_pairs: Object.freeze([["A", "B"]] as const) });
    const checker = checkDecisionStability(checkerInput(world, emptyFixture(1)));
    expect(checker.status).toBe("UNCERTIFIED_OPEN");
  });

  it("refuses to mint when compiled CQ is not the live canonical query", () => {
    const world = worldOf(["A"]);
    const liveDigest = authorityFrom(prepared).canonical_query_compilation.digest;
    expect(world.compiled.compilation_digest).not.toBe(liveDigest);
    const checker = checkDecisionStability(checkerInput(world, emptyFixture(1)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
  });

  it("fails closed on tampered query, policy, walk, and operator identity", () => {
    const world = worldOf(["A"]);
    const queryTamper = checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      compiled: { ...world.compiled, query_digest: `sha256:${"b".repeat(64)}` }
    });
    expect(queryTamper.status).toBe("UNSUPPORTED");

    const policyWorld = worldFromQuery(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] })
    ], {
      resource_policy: {
        schema_version: 1,
        reject_duplicate_object: true,
        token_budget: 4,
        per_dimension_limits: null
      }
    }, { token_budget: 10 });
    const policyTamper = checkDecisionStability(checkerInput(policyWorld, emptyFixture(1)));
    expect(policyTamper.status).toBe("UNSUPPORTED");

    const operatorTamper = checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      concrete_operator: {
        operator_id: "not_final_decision_v1",
        decide: createQueryProofDecisionOperator(world).decide
      }
    });
    expect(operatorTamper.status).toBe("UNSUPPORTED");

    const checker = checkDecisionStability(checkerInput(world, emptyFixture(1)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
    expect(SHADOW_CAPTURE_OPERATOR_ID).toBeDefined();
    expect(QUERY_PROOF_FINAL_DECISION_OPERATOR_ID).toBe(
      createQueryProofDecisionOperator(world).operator_id
    );
  });

  it("does not certify finite identity remaining effects that split the prefix", () => {
    const world = worldOf(["A", "B"]);
    const fixture: FiniteOracleFixture = {
      fixture_id: "identity-split",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [{
        coordinate_id: "identity-tail",
        sensitivity_id: "sensitivity:identity-tail",
        owner_id: "owner:identity-tail",
        kind: "identity_tie",
        abstract_kind: "identity_tie",
        choices: [
          { choice_id: "A", value: candidateIdentityDigest("A") },
          { choice_id: "B", value: candidateIdentityDigest("B") }
        ]
      }]
    };
    const checker = checkDecisionStability(checkerInput(world, fixture, [{
      coordinate_id: "identity-tail",
      sensitivity_id: "sensitivity:identity-tail",
      owner_id: "owner:identity-tail",
      kind: "identity_tie",
      universe: "finite",
      possible_winner_digests: [candidateIdentityDigest("A"), candidateIdentityDigest("B")]
    }]));
    expect(checker.status).not.toBe("CERTIFIED_STABLE");
  });

  it("does not certify proposition or correlation remaining effects that change the trace", () => {
    const query = scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }], [{
      id: "need-ind",
      constraint: "independent_support",
      arguments: ["x"]
    }]);
    const world = worldFromQuery(query, [
      candidate("Z", {
        bindings: [binding("alice")],
        propositions: [
          proposition("rel1"),
          proposition("need-ind", "supports", "certified_independent", "constraint")
        ]
      }),
      candidate("A", {
        bindings: [binding("bob")],
        propositions: [
          proposition("rel1"),
          proposition("need-ind", "supports", "correlated", "constraint")
        ]
      })
    ]);
    expect(checkDecisionStability(checkerInput(world, emptyFixture(1))).status)
      .toBe("UNSUPPORTED");
    expect(runQueryProofDecideQ(world, 1).prefix).toEqual(["Z"]);
    const correlation: FiniteOracleFixture = {
      fixture_id: "correlation-open",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [{
        coordinate_id: "Z",
        sensitivity_id: "sensitivity:correlation",
        owner_id: "owner:correlation",
        kind: "correlation_state",
        abstract_kind: "correlation",
        choices: [
          { choice_id: "same_group", value: "same_group" },
          { choice_id: "different_group", value: "different_group" }
        ]
      }]
    };
    expect(checkDecisionStability(checkerInput(world, correlation, [{
      coordinate_id: "Z",
      sensitivity_id: "sensitivity:correlation",
      owner_id: "owner:correlation",
      kind: "correlation",
      possible_relations: ["same_group", "different_group"]
    }])).status).not.toBe("CERTIFIED_STABLE");

    const conflict: FiniteOracleFixture = {
      fixture_id: "proposition-open",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [{
        coordinate_id: "rel1",
        sensitivity_id: "sensitivity:prop",
        owner_id: "owner:prop",
        kind: "proposition_conflict",
        abstract_kind: "four_valued_proposition",
        choices: [
          { choice_id: "supported_only", value: "supported_only" },
          { choice_id: "refutes", value: "refutes" }
        ]
      }]
    };
    expect(checkDecisionStability(checkerInput(world, conflict, [{
      coordinate_id: "rel1",
      sensitivity_id: "sensitivity:prop",
      owner_id: "owner:prop",
      kind: "four_valued_proposition",
      possible_values: ["supported_only", "refutes"]
    }])).status).not.toBe("CERTIFIED_STABLE");
  });

  it("certifies empty-coordinate Decide_Q for every v1 operator fixture", () => {
    const operators: readonly QueryProofDecideWorldV1[] = [
      worldFromQuery(scalarQuery(), [candidate("A", { bindings: [binding("alice")] })]),
      worldFromQuery(distinctQuery(), [candidate("A", { bindings: [binding("alice")] })]),
      worldFromQuery(sequenceQuery(1), [
        candidate("A", { sequence_slots: [{ position: 0, binding: "alice" }] })
      ])
    ];
    for (const world of operators) {
      expect(world.compiled.compile_status).toBe("compiled");
      expect(runQueryProofDecideQ(world, 1).prefix.length).toBeGreaterThan(0);
      const checker = checkDecisionStability(checkerInput(world, emptyFixture(1)));
      expect(checker.status).toBe("UNSUPPORTED");
      if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
      expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
    }
  });

  it("lifts same-lineage complementary support through SealChecker", () => {
    const world = worldFromQuery(scalarQuery([
      { id: "rel1", relation: "bought", arguments: ["x"] },
      { id: "rel2", relation: "from", arguments: ["x"] }
    ]), [
      candidate("first", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1"), proposition("rel2", "absent")]
      }),
      candidate("lineage", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "absent"), proposition("rel2")]
      })
    ]);
    const decided = runQueryProofDecideQ(world, 2);
    expect(decided.prefix).toEqual(["first", "lineage"]);
    const checker = checkDecisionStability(checkerInput(world, emptyFixture(2)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
  });

  it("records zero false Decide_Q singletons across operators and simultaneous remaining effects", () => {
    const operators: readonly QueryProofDecideWorldV1[] = [
      worldFromQuery(scalarQuery(), [candidate("A", { bindings: [binding("alice")] })]),
      worldFromQuery(distinctQuery(), [candidate("A", { bindings: [binding("alice")] })]),
      worldFromQuery(sequenceQuery(1), [
        candidate("A", { sequence_slots: [{ position: 0, binding: "alice" }] })
      ])
    ];
    for (const world of operators) {
      expect(noFalseSingleton(world, emptyFixture(1), [])).toBe(false);
    }
    const split = worldOf(["A", "B"]);
    const fixture: FiniteOracleFixture = {
      fixture_id: "simultaneous-novelty-feasibility-tie",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: {},
      coordinates: [
        {
          coordinate_id: "B",
          sensitivity_id: "sensitivity:membership",
          owner_id: "B",
          kind: "candidate_membership",
          abstract_kind: "membership",
          choices: [
            { choice_id: "absent", value: false },
            { choice_id: "present", value: true }
          ]
        },
        {
          coordinate_id: "A",
          sensitivity_id: "sensitivity:feasibility",
          owner_id: "A",
          kind: "semantic_feasibility",
          abstract_kind: "semantic_feasibility",
          choices: [
            { choice_id: "feasible", value: "feasible" },
            { choice_id: "infeasible", value: "infeasible" }
          ]
        },
        {
          coordinate_id: "identity-tail",
          sensitivity_id: "sensitivity:identity-tail",
          owner_id: "owner:identity-tail",
          kind: "identity_tie",
          abstract_kind: "identity_tie",
          choices: [
            { choice_id: "A", value: candidateIdentityDigest("A") },
            { choice_id: "B", value: candidateIdentityDigest("B") }
          ]
        }
      ]
    };
    const coordinates = [
      {
        coordinate_id: "B",
        sensitivity_id: "sensitivity:membership",
        owner_id: "B",
        kind: "membership" as const,
        possible_states: ["absent", "present"] as const
      },
      {
        coordinate_id: "A",
        sensitivity_id: "sensitivity:feasibility",
        owner_id: "A",
        kind: "semantic_feasibility" as const,
        possible_states: ["feasible", "infeasible"] as const
      },
      {
        coordinate_id: "identity-tail",
        sensitivity_id: "sensitivity:identity-tail",
        owner_id: "owner:identity-tail",
        kind: "identity_tie" as const,
        universe: "finite" as const,
        possible_winner_digests: [candidateIdentityDigest("A"), candidateIdentityDigest("B")]
      }
    ];
    expect(checkDecisionStability(checkerInput(split, fixture, coordinates)).status)
      .not.toBe("CERTIFIED_STABLE");
    expect(noFalseSingleton(split, fixture, coordinates)).toBe(false);
  });

  it("lifts higher-stratum budget priority through Decide_Q", () => {
    const base = worldFromQuery(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("binding", { bindings: [binding("alice")], token_cost: 2 }),
      candidate("prop-only", {
        bindings: [],
        propositions: [proposition("rel1")],
        token_cost: 1
      })
    ], {
      resource_policy: {
        schema_version: 1,
        reject_duplicate_object: true,
        token_budget: 3,
        per_dimension_limits: null
      }
    }, { token_budget: 3 });
    const world = Object.freeze({
      ...base,
      candidates: base.candidates.map((row) => Object.freeze({
        ...row,
        token_cost: row.candidate_key === "binding" ? 2 : 1
      }))
    });
    const decided = runQueryProofDecideQ(world, 2);
    expect(decided.prefix[0]).toBe("binding");
    expect(checkDecisionStability(checkerInput(world, emptyFixture(2))).status)
      .toBe("UNSUPPORTED");
  });

  it("lifts target-only lower-frontier novelty through SealChecker", () => {
    const base = worldFromQuery(distinctQuery(), [
      candidate("core", { bindings: [] }),
      candidate("lower", { bindings: [binding("bob")] })
    ]);
    const world = Object.freeze({
      ...base,
      psi_edges: Object.freeze([["core", "lower"]] as const),
      candidates: base.candidates.map((row) => Object.freeze({
        ...row,
        static_frontier_index: row.candidate_key === "core" ? 1 : 2
      }))
    });
    const decided = runQueryProofDecideQ(world, 2);
    expect(decided.prefix).toContain("lower");
    expect(checkDecisionStability(checkerInput(world, emptyFixture(2))).status)
      .toBe("UNSUPPORTED");
  });

  it("keeps a partial oracle base_state from dropping trade-off pairs", () => {
    const world = worldFromQuery(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ], {}, { unresolved_tradeoff_pairs: Object.freeze([["A", "B"]] as const) });
    const fixture: FiniteOracleFixture = {
      ...emptyFixture(1),
      base_state: {
        compiled: world.compiled as never,
        candidates: world.candidates as never
      }
    };
    const checker = checkDecisionStability(checkerInput(world, fixture));
    expect(checker.status).toBe("UNCERTIFIED_OPEN");
  });

  it("fails closed when same-id substitute operators try to mint a singleton", () => {
    const world = worldOf(["A", "B"]);
    const fakeTrace = Object.freeze({
      candidate_prefix: Object.freeze(["A"]),
      answer_bindings: Object.freeze([]),
      pick_reasons: Object.freeze([{
        position: 0,
        candidate_key: "A",
        reason_id: "planted-substitute"
      }])
    });
    const checker = checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      concrete_operator: {
        operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
        decide: () => fakeTrace
      },
      abstract_operator: {
        operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
        evaluate: () => Object.freeze({
          status: "outcomes" as const,
          handled_sensitivity_ids: Object.freeze([] as string[]),
          outcomes: Object.freeze([fakeTrace])
        })
      }
    });
    expect(checker.status).not.toBe("CERTIFIED_STABLE");
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toMatch(/substitute Decide_Q/u);
  });

  it("fails closed when a live-trace wrapper is not the branded live operator", () => {
    const world = worldOf(["A"]);
    const live = createQueryProofDecisionOperator(world);
    const liveAbstract = createQueryProofAbstractOperator(world);
    const wrapper = {
      operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
      decide: (input: Parameters<typeof live.decide>[0]) => live.decide(input)
    };
    expect(checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      concrete_operator: wrapper,
      abstract_operator: liveAbstract
    }).status).toBe("UNSUPPORTED");
    expect(checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      concrete_operator: live,
      abstract_operator: {
        operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
        evaluate: liveAbstract.evaluate
      }
    }).reason).toMatch(/substitute Decide_Q/u);
  });

  it("refuses a compiled-looking semantic-feasibility forgery", () => {
    const honest = worldFromQuery(scalarQuery(), [
      candidate("open", { bindings_status: "unknown" }),
      candidate("ok", { bindings: [binding("alice")] })
    ]);
    const forgedCompiled = Object.freeze({
      ...honest.compiled,
      semantic_feasibility: Object.freeze(honest.compiled.semantic_feasibility.map((row) =>
        Object.freeze({ ...row, semantic: "feasible" as const })))
    });
    const forged = Object.freeze({ ...honest, compiled: forgedCompiled });
    const checker = checkDecisionStability({
      ...checkerInput(forged, emptyFixture(1)),
      compiled: forgedCompiled
    });
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe("compiled Gamma does not match Decide_Q compile input");
  });

  it("refuses a compiled-looking standings forgery", () => {
    const honest = worldFromQuery(scalarQuery(), [
      candidate("open", { bindings_status: "unknown" }),
      candidate("ok", { bindings: [binding("alice")] })
    ]);
    const forgedCompiled = Object.freeze({
      ...honest.compiled,
      standings: Object.freeze(honest.compiled.standings.map((row) =>
        Object.freeze({ ...row, coverage: "covers" as const })))
    });
    const forged = Object.freeze({ ...honest, compiled: forgedCompiled });
    const checker = checkDecisionStability({
      ...checkerInput(forged, emptyFixture(1)),
      compiled: forgedCompiled
    });
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe("compiled Gamma does not match Decide_Q compile input");
    expect(digestDecideWorld(forged)).not.toBe(digestDecideWorld(honest));
  });

  it("refuses a world Gamma that diverges from the checker compiled witness", () => {
    const honest = worldFromQuery(scalarQuery(), [
      candidate("open", { bindings_status: "unknown" }),
      candidate("ok", { bindings: [binding("alice")] })
    ]);
    const forgedCompiled = Object.freeze({
      ...honest.compiled,
      semantic_feasibility: Object.freeze(honest.compiled.semantic_feasibility.map((row) =>
        Object.freeze({ ...row, semantic: "feasible" as const })))
    });
    const forgedWorld = Object.freeze({ ...honest, compiled: forgedCompiled });
    const checker = checkDecisionStability({
      ...checkerInput(forgedWorld, emptyFixture(1)),
      compiled: honest.compiled,
      world: forgedWorld,
      concrete_operator: createQueryProofDecisionOperator(forgedWorld),
      abstract_operator: createQueryProofAbstractOperator(forgedWorld)
    });
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe("compiled Gamma does not match Decide_Q world");
  });

  it("refuses a world Gamma whose stored digest does not match the owned body", () => {
    const honest = worldFromQuery(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    const forgedCompiled = Object.freeze({
      ...honest.compiled,
      independent_support_obligation: !honest.compiled.independent_support_obligation
    });
    const forgedWorld = Object.freeze({ ...honest, compiled: forgedCompiled });
    const checker = checkDecisionStability({
      ...checkerInput(forgedWorld, emptyFixture(1)),
      compiled: honest.compiled,
      world: forgedWorld,
      concrete_operator: createQueryProofDecisionOperator(forgedWorld),
      abstract_operator: createQueryProofAbstractOperator(forgedWorld)
    });
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe("compiled Gamma digest does not match Gamma body");
  });

  it("parses world and proof-state digests as seal identity", () => {
    const world = worldOf(["A"]);
    const input = checkerInput(world, emptyFixture(1));
    const worldDigest = digestDecideWorld(world);
    const proofState = digestQueryProofState(input);
    expect(proofState).not.toBe(digestQueryProofState(checkerInput(world, emptyFixture(2))));
    const body = Object.freeze({
      schema_version: 1 as const,
      operator_id: DECISION_STABILITY_SEAL_OPERATOR_ID,
      decision_contract_digest: runQueryProofDecideQ(world, 1).decision_contract_digest,
      authority_digest: deriveLiveClosureAuthorityBinding(authorityFrom(prepared)).authority_digest,
      query_digest: world.compiled.query_digest,
      compilation_digest: world.compiled.compilation_digest,
      live_compilation_digest: world.compiled.compilation_digest,
      world_digest: worldDigest,
      proof_state_digest: proofState,
      snapshot_digest: authorityFrom(prepared).snapshot_vector.vector_digest,
      gamma_digest: world.compiled.gamma_digest,
      walk_operator_id: SHADOW_CAPTURE_OPERATOR_ID,
      k_max: 1,
      candidate_prefix: Object.freeze(["A"]),
      answer_bindings: Object.freeze([]),
      pick_reasons: Object.freeze([{
        position: 0,
        candidate_key: "A",
        reason_id: "core_undominated:A"
      }]),
      outcome_digest: digestRecallFieldIdentity({
        candidate_prefix: Object.freeze(["A"]),
        answer_bindings: Object.freeze([]),
        pick_reasons: Object.freeze([{
          position: 0,
          candidate_key: "A",
          reason_id: "core_undominated:A"
        }])
      })
    });
    const parsed = parseDecisionStabilitySeal({
      ...body,
      seal_digest: digestRecallFieldIdentity(body)
    });
    expect(parsed.world_digest).toBe(worldDigest);
    expect(parsed.proof_state_digest).toBe(proofState);
    expect(() => parseDecisionStabilitySeal({
      ...parsed,
      world_digest: `sha256:${"e".repeat(64)}`
    })).toThrow(/digest mismatch/u);
  });

  it("fails closed on a blocks_certified_delivery hole even if Gamma looks compiled", () => {
    const live = authorityFrom(prepared).canonical_query_compilation;
    expect(live.holes.some((row) => row.impacts.includes("blocks_certified_delivery"))).toBe(true);
    const world = worldOf(["A"]);
    expect(world.compiled.compile_status).toBe("compiled");
    const mixedCompiled = withCompilationDigest(world.compiled, live.digest);
    const mixed = Object.freeze({
      ...world,
      compiled: mixedCompiled,
      compile_input: Object.freeze({
        ...world.compile_input,
        compilation: live
      })
    });
    const checker = checkDecisionStability({
      ...checkerInput(mixed, emptyFixture(1)),
      compiled: mixedCompiled
    });
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe("compiled Gamma does not match Decide_Q compile input");
  });

  it("refuses a live compilation digest copied onto a different compilation body", () => {
    const live = authorityFrom(prepared).canonical_query_compilation;
    const world = worldOf(["A"]);
    expect(world.compile_input.compilation.digest).not.toBe(live.digest);
    const liedCompilation = Object.freeze({
      ...world.compile_input.compilation,
      digest: live.digest
    });
    const liedCompiled = withCompilationDigest(world.compiled, live.digest);
    const liedWorld = Object.freeze({
      ...world,
      compiled: liedCompiled,
      compile_input: Object.freeze({
        ...world.compile_input,
        compilation: liedCompilation
      })
    });
    const checker = checkDecisionStability({
      ...checkerInput(liedWorld, emptyFixture(1)),
      compiled: liedCompiled
    });
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe("canonical query compilation digest mismatch");
  });

  it("deep-freezes nested decide-world bindings so later mutation cannot change the digest", () => {
    const bindingRow = {
      candidate_key: "A",
      binding_id: "bind:A",
      value: "A" as const
    };
    const feasibilityRow = {
      candidate_key: "A",
      semantic: "feasible" as const
    };
    const world = Object.freeze({
      ...worldOf(["A"]),
      compiled: Object.freeze({
        ...worldOf(["A"]).compiled,
        semantic_feasibility: [feasibilityRow]
      }),
      answer_bindings: [bindingRow]
    });
    const frozen = freezeDecideWorld(world);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.answer_bindings[0])).toBe(true);
    expect(Object.isFrozen(frozen.compiled.semantic_feasibility[0])).toBe(true);
    const digest = digestDecideWorld(frozen);
    bindingRow.value = "mutated";
    feasibilityRow.semantic = "infeasible";
    expect(digestDecideWorld(frozen)).toBe(digest);
    expect(frozen.answer_bindings[0]?.value).toBe("A");
    expect(frozen.compiled.semantic_feasibility[0]?.semantic).toBe("feasible");
  });

  it("does not rebind checker digest after a later raw-world getter or array swap", () => {
    const world = worldOf(["A"]);
    const expectedDigest = runQueryProofDecideQ(world, 1).decision_contract_digest;
    let compiledReads = 0;
    const switching = new Proxy(world, {
      get(target, property, receiver) {
        if (property === "compiled") {
          compiledReads += 1;
          return compiledReads === 1
            ? target.compiled
            : Object.freeze({
                ...target.compiled,
                gamma_digest: `sha256:${"f".repeat(64)}`
              });
        }
        return Reflect.get(target, property, receiver);
      }
    });
    let bindingReads = 0;
    const swapping = new Proxy(world, {
      get(target, property, receiver) {
        if (property === "answer_bindings") {
          bindingReads += 1;
          return bindingReads === 1
            ? target.answer_bindings
            : Object.freeze([{
                candidate_key: "A",
                binding_id: "bind:A",
                value: "swapped"
              }]);
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const checker = checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      world: switching,
      compiled: world.compiled
    });
    expect(checker.decision_contract_digest).toBe(expectedDigest);
    expect(compiledReads).toBe(1);
    const swapped = checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      world: swapping,
      compiled: world.compiled
    });
    expect(swapped.decision_contract_digest).toBe(expectedDigest);
    expect(bindingReads).toBe(1);
  });

  it("binds concrete and abstract operator callbacks once before proof", () => {
    const world = worldOf(["A"]);
    const liveConcrete = createQueryProofDecisionOperator(world);
    const liveAbstract = createQueryProofAbstractOperator(world);
    let decideReads = 0;
    let evaluateReads = 0;
    const switchingConcrete = new Proxy(liveConcrete, {
      get(target, property, receiver) {
        if (property === "decide") {
          decideReads += 1;
          return decideReads === 1
            ? target.decide
            : () => Object.freeze({
                candidate_prefix: Object.freeze(["injected"]),
                answer_bindings: Object.freeze([]),
                pick_reasons: Object.freeze([])
              });
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const switchingAbstract = new Proxy(liveAbstract, {
      get(target, property, receiver) {
        if (property === "evaluate") {
          evaluateReads += 1;
          return evaluateReads === 1
            ? target.evaluate
            : () => Object.freeze({
                status: "outcomes" as const,
                handled_sensitivity_ids: Object.freeze([] as string[]),
                outcomes: Object.freeze([])
              });
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const checker = checkDecisionStability({
      ...checkerInput(world, emptyFixture(1)),
      concrete_operator: switchingConcrete,
      abstract_operator: switchingAbstract
    });
    expect(decideReads).toBe(1);
    expect(evaluateReads).toBe(1);
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toBe(
      "compiled compilation digest does not match live canonical query"
    );
  });

  it("fails closed when compile-input and world candidate universes differ", () => {
    const honest = worldOf(["A", "B"]);
    const compileOnly = Object.freeze({
      ...honest,
      candidates: honest.candidates.filter((row) => row.candidate_key === "A"),
      answer_bindings: honest.answer_bindings.filter((row) => row.candidate_key === "A")
    });
    expect(() => runQueryProofDecideQ(compileOnly, 1)).toThrow(/universes differ/u);
    const compileChecker = checkDecisionStability(checkerInput(compileOnly, emptyFixture(1)));
    expect(compileChecker.status).toBe("UNSUPPORTED");
    if (compileChecker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(compileChecker.reason).toMatch(/universes differ/u);
    expect(compileChecker.status).not.toBe("CERTIFIED_STABLE");

    const present = worldOf(["A"]);
    const worldOnly = Object.freeze({
      ...present,
      candidates: Object.freeze([
        ...present.candidates,
        Object.freeze({
          candidate_key: "ghost",
          object_key: "ghost",
          token_cost: 1,
          dimension: "mem",
          h_eligible: true,
          utility: emptyWalkUtility("ghost", "ghost"),
          static_frontier_index: null
        })
      ])
    });
    expect(() => runQueryProofDecideQ(worldOnly, 1)).toThrow(/universes differ/u);
    const worldChecker = checkDecisionStability(checkerInput(worldOnly, emptyFixture(1)));
    expect(worldChecker.status).toBe("UNSUPPORTED");
    if (worldChecker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(worldChecker.reason).toMatch(/universes differ/u);
  });

  it("fails closed on duplicate feasible and infeasible rows for one candidate", () => {
    const honest = worldOf(["A"]);
    const both = Object.freeze({
      ...honest,
      compiled: Object.freeze({
        ...honest.compiled,
        semantic_feasibility: Object.freeze([
          { candidate_key: "A", semantic: "feasible" as const },
          { candidate_key: "A", semantic: "infeasible" as const }
        ])
      })
    });
    expect(() => runQueryProofDecideQ(both, 1)).toThrow(/duplicate compiled feasibility/u);
    const checker = checkDecisionStability(checkerInput(both, emptyFixture(1)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toMatch(/duplicate compiled feasibility/u);
    expect(checker.status).not.toBe("CERTIFIED_STABLE");
  });

  it("fails closed on missing or duplicate compiled standing rows", () => {
    const honest = worldOf(["A"]);
    const missing = Object.freeze({
      ...honest,
      compiled: Object.freeze({
        ...honest.compiled,
        standings: Object.freeze(honest.compiled.standings.slice(1))
      })
    });
    expect(() => runQueryProofDecideQ(missing, 1)).toThrow(/standings are not one row/u);
    const missingChecker = checkDecisionStability(checkerInput(missing, emptyFixture(1)));
    expect(missingChecker.status).toBe("UNSUPPORTED");
    if (missingChecker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(missingChecker.reason).toMatch(/standings are not one row/u);

    const duplicated = Object.freeze({
      ...honest,
      compiled: Object.freeze({
        ...honest.compiled,
        standings: Object.freeze([
          ...honest.compiled.standings,
          honest.compiled.standings[0]!
        ])
      })
    });
    expect(() => runQueryProofDecideQ(duplicated, 1)).toThrow(/duplicate compiled standing/u);
    const duplicateChecker = checkDecisionStability(checkerInput(duplicated, emptyFixture(1)));
    expect(duplicateChecker.status).toBe("UNSUPPORTED");
    if (duplicateChecker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(duplicateChecker.reason).toMatch(/duplicate compiled standing/u);
  });

  it("fails closed on duplicate compile-input candidate keys in a Decide_Q world", () => {
    const honest = worldOf(["A"]);
    const duplicated = Object.freeze({
      ...honest,
      compile_input: Object.freeze({
        ...honest.compile_input,
        candidates: Object.freeze([
          ...honest.compile_input.candidates,
          honest.compile_input.candidates[0]!
        ])
      })
    });
    expect(() => runQueryProofDecideQ(duplicated, 1))
      .toThrow(/duplicate compile-input candidate_key/u);
    const checker = checkDecisionStability(checkerInput(duplicated, emptyFixture(1)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toMatch(/duplicate compile-input candidate_key/u);
  });

  it("fails closed when compiled feasibility has extra keys beyond the world universe", () => {
    const honest = worldOf(["A"]);
    const extra = Object.freeze({
      ...honest,
      compiled: Object.freeze({
        ...honest.compiled,
        semantic_feasibility: Object.freeze([
          ...honest.compiled.semantic_feasibility,
          { candidate_key: "ghost", semantic: "feasible" as const }
        ])
      })
    });
    expect(() => runQueryProofDecideQ(extra, 1))
      .toThrow(/feasibility is not one row/u);
    const checker = checkDecisionStability(checkerInput(extra, emptyFixture(1)));
    expect(checker.status).toBe("UNSUPPORTED");
    if (checker.status !== "UNSUPPORTED") throw new Error("expected refuse");
    expect(checker.reason).toMatch(/feasibility is not one row/u);
    expect(checker.status).not.toBe("CERTIFIED_STABLE");
  });

  it("membership overlay keeps one unique key universe and the query-owned Gamma digest", () => {
    const world = worldOf(["A", "B"]);
    const overlay = overlayWorld(world, {}, {
      assignments: Object.freeze([
        Object.freeze({
          coordinate_id: "B",
          owner_id: "B",
          kind: "candidate_membership" as const,
          choice_id: "absent",
          value: false
        })
      ]),
      refinement_digest: digestRecallFieldIdentity({ overlay: "drop-B" })
    });
    expect(overlay.compile_input.candidates.map((row) => row.candidate_key)).toEqual(["A"]);
    expect(overlay.candidates.map((row) => row.candidate_key)).toEqual(["A"]);
    expect(overlay.compiled.semantic_feasibility.map((row) => row.candidate_key))
      .toEqual(["A"]);
    expect(overlay.compiled.standings.every((row) => row.candidate_key === "A")).toBe(true);
    expect(overlay.compiled.gamma_digest).toBe(world.compiled.gamma_digest);
    expect(runQueryProofDecideQ(overlay, 1).prefix).toEqual(["A"]);
  });
});
