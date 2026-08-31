import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from
  "../../../../../../recall/field/field-identity.js";
import { enumerateFiniteDecisionOracle } from
  "../../../../../../recall/decision/query-proof/proof/oracle/oracle.js";
import type { FiniteDecisionOperator, FiniteOracleFixture } from
  "../../../../../../recall/decision/query-proof/proof/oracle/contract.js";
import {
  verifyAbstractProofKernelResult,
  type AbstractProofKernelResult
} from "../../../../../../recall/decision/query-proof/proof/abstract/contract.js";
import { evaluateAbstractProofKernel } from
  "../../../../../../recall/decision/query-proof/proof/abstract/kernel.js";
import {
  certifyAbstractSingletonWithFiniteOracle,
  compareAbstractProofToOracle
} from "../../../../../../recall/decision/query-proof/proof/abstract/differential.js";
import type { PreparedRecallRequest } from
  "../../../../../../recall/runtime/recall-service-runner-types.js";
import {
  authorityFrom,
  cleanup,
  preparedAuthority
} from "../../../../integration/shadow/live-receipt-fixtures.js";
import {
  createKernelCase,
  fixtureCoordinate,
  identityCoordinate,
  membershipCoordinate,
  singletonOperator,
  trace
} from "./proof-fixture.js";

let prepared: PreparedRecallRequest;

beforeAll(async () => {
  prepared = await preparedAuthority();
});

afterAll(() => cleanup(prepared));

describe("oracle-certified abstract proof kernel", () => {
  it("keeps an abstract singleton candidate OPEN without a certificate", () => {
    const testCase = createKernelCase(authorityFrom(prepared));
    const result = evaluateAbstractProofKernel(testCase.input);

    expect(result.status).toBe("OPEN");
    expect(result).toMatchObject({
      reason: "finite oracle differential certificate required"
    });
  });

  it("certifies a singleton only after exact finite-oracle replay", () => {
    const testCase = createKernelCase(authorityFrom(prepared));
    const oracle = enumerate(testCase.fixture, testCase.concrete);
    const proved = certifyAbstractSingletonWithFiniteOracle(testCase.input, oracle);

    expect(proved.status).toBe("PROVED_SINGLETON");
    if (proved.status !== "PROVED_SINGLETON") throw new Error("expected proof");
    expect(proved.differential_certificate.false_singleton).toBe(false);
    expect(proved.differential_certificate.missing_concrete_outcome_digests).toEqual([]);
    expect(() => verifyAbstractProofKernelResult(proved, testCase.input, oracle))
      .not.toThrow();
    expect(compareAbstractProofToOracle(testCase.input, proved, oracle))
      .toEqual({ false_singleton: false, missing_concrete_outcome_digests: [] });
  });

  it("does not certify a lying narrow abstract operator over two concrete outcomes", () => {
    const coordinate = membershipCoordinate(["absent", "present"]);
    const fixture = membershipFixture();
    const concrete = membershipConcrete();
    const testCase = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate],
      fixture,
      concrete,
      operator: singletonOperator([coordinate.sensitivity_id], ["candidate-a"]),
      k_max: 1
    });
    const oracle = enumerate(testCase.fixture, concrete);
    const result = certifyAbstractSingletonWithFiniteOracle(testCase.input, oracle);

    expect(oracle.outcomes).toHaveLength(2);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result).toMatchObject({
      reason: expect.stringMatching(/under-approximates/u)
    });
    expect(compareAbstractProofToOracle(testCase.input, result, oracle)
      .missing_concrete_outcome_digests).toHaveLength(2);
  });

  it("rejects an omitted manifest coordinate and an unhandled sensitivity", () => {
    const coordinate = membershipCoordinate(["present"]);
    const fixture = membershipFixture([true]);
    const omitted = createKernelCase(authorityFrom(prepared), {
      coordinates: [], fixture, concrete: membershipConcrete(), k_max: 1
    });
    const unhandled = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate], fixture, concrete: membershipConcrete(),
      operator: singletonOperator([]), k_max: 1
    });
    const extra = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate], fixture, concrete: membershipConcrete(),
      operator: singletonOperator([coordinate.sensitivity_id, "sensitivity:invented"]),
      k_max: 1
    });

    expect(evaluateAbstractProofKernel(omitted.input)).toMatchObject({
      status: "UNSUPPORTED",
      reason: expect.stringMatching(/exactly cover/u)
    });
    expect(evaluateAbstractProofKernel(unhandled.input)).toMatchObject({
      status: "OPEN",
      reason: expect.stringMatching(/complete sensitivity manifest/u)
    });
    expect(evaluateAbstractProofKernel(extra.input)).toMatchObject({
      status: "UNSUPPORTED",
      reason: expect.stringMatching(/outside the finite manifest/u)
    });
  });

  it("fails closed on a K_max mismatch", () => {
    const testCase = createKernelCase(authorityFrom(prepared), {
      fixture: { ...membershipFixture([true]), k_max: 1 },
      coordinates: [membershipCoordinate(["present"])],
      concrete: membershipConcrete(),
      k_max: 2
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "UNSUPPORTED",
      reason: expect.stringMatching(/K_max/u)
    });
  });

  it("rejects forged PROVED results and certificate relabeling", () => {
    const testCase = createKernelCase(authorityFrom(prepared));
    const oracle = enumerate(testCase.fixture, testCase.concrete);
    const proved = certifyAbstractSingletonWithFiniteOracle(testCase.input, oracle);
    if (proved.status !== "PROVED_SINGLETON") throw new Error("expected proof");
    const relabeledCertificate = {
      ...proved.differential_certificate,
      abstract_operator_id: "fixture_relabelled_abstract_v1"
    };
    const relabeledBody = {
      ...proved,
      differential_certificate: {
        ...relabeledCertificate,
        certificate_digest: digestRecallFieldIdentity(relabeledCertificate)
      },
      proof_digest: undefined
    };
    const { proof_digest: _proofDigest, ...body } = relabeledBody;
    const relabeled = { ...body,
      proof_digest: digestRecallFieldIdentity(body)
    } as AbstractProofKernelResult;
    const forged = { ...proved, status: "OPEN" } as unknown as AbstractProofKernelResult;

    expect(() => verifyAbstractProofKernelResult(relabeled, testCase.input, oracle))
      .toThrow(/certificate mismatch/u);
    expect(() => verifyAbstractProofKernelResult(forged, testCase.input))
      .toThrow(/unknown or missing fields|digest mismatch/u);
  });

  it("rejects an unrelated/relabelled concrete operator certificate pair", () => {
    const original = createKernelCase(authorityFrom(prepared));
    const oracle = enumerate(original.fixture, original.concrete);
    const relabeledConcrete = Object.freeze({ ...original.concrete,
      operator_id: "fixture_unrelated_concrete_v1" });
    const unrelated = createKernelCase(authorityFrom(prepared), {
      fixture: original.fixture,
      concrete: relabeledConcrete
    });

    expect(() => certifyAbstractSingletonWithFiniteOracle(unrelated.input, oracle))
      .toThrow(/exact operator replay/u);
  });

  it("deep-freezes the exact fixture retained by the transfer input", () => {
    const nested = { values: ["original"] };
    const coordinates = [fixtureCoordinate("membership", "candidate_membership",
      "membership", [true])];
    const mutable: FiniteOracleFixture = {
      fixture_id: "mutable-transfer",
      snapshot_digest: prepared.snapshotVector.vector_digest,
      k_max: 1,
      base_state: { nested },
      coordinates
    };
    const testCase = createKernelCase(authorityFrom(prepared), {
      fixture: mutable,
      coordinates: [membershipCoordinate(["present"])],
      concrete: membershipConcrete(),
      k_max: 1
    });
    nested.values[0] = "mutated";

    expect(testCase.input.fixture.base_state).toEqual({ nested: { values: ["original"] } });
    expect(Object.isFrozen(testCase.input.fixture)).toBe(true);
    expect(Object.isFrozen(testCase.input.fixture.base_state)).toBe(true);
    expect(Object.isFrozen(testCase.input.fixture.coordinates[0]!.choices)).toBe(true);
  });

  it("keeps an open identity tail OPEN before invoking the operator", () => {
    const coordinate = identityCoordinate("open");
    const testCase = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate]
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "OPEN",
      reason: "unresolved channel or abstract domain"
    });
  });

  it("records zero false singletons across the declared finite differential corpus", () => {
    const singleton = createKernelCase(authorityFrom(prepared));
    const membership = membershipCoordinate(["absent", "present"]);
    const open = createKernelCase(authorityFrom(prepared), {
      coordinates: [membership],
      fixture: membershipFixture(),
      concrete: membershipConcrete(),
      operator: Object.freeze({
        operator_id: "fixture_membership_complete_abstract_v1",
        evaluate: () => Object.freeze({
          status: "outcomes" as const,
          handled_sensitivity_ids: Object.freeze([membership.sensitivity_id]),
          outcomes: Object.freeze([trace([], "membership"),
            trace(["candidate-a"], "membership")])
        })
      }),
      k_max: 1
    });
    const cases = [singleton, open];
    const comparisons = cases.map((testCase) => {
      const oracle = enumerate(testCase.fixture, testCase.concrete);
      const proof = certifyAbstractSingletonWithFiniteOracle(testCase.input, oracle);
      return compareAbstractProofToOracle(testCase.input, proof, oracle);
    });

    expect(comparisons.some(({ false_singleton }) => false_singleton)).toBe(false);
    expect(comparisons.flatMap(({ missing_concrete_outcome_digests }) =>
      missing_concrete_outcome_digests)).toEqual([]);
  });

  it("captures the abstract input before a caller-owned fixture switch", () => {
    const testCase = createKernelCase(authorityFrom(prepared));
    let fixtureReads = 0;
    const switching = new Proxy({ ...testCase.input }, {
      get(target, property, receiver) {
        if (property === "fixture") {
          fixtureReads += 1;
          return fixtureReads === 1
            ? testCase.input.fixture
            : { ...testCase.input.fixture, k_max: 0 };
        }
        return Reflect.get(target, property, receiver);
      }
    });

    const result = evaluateAbstractProofKernel(switching);

    expect(result.status).toBe("OPEN");
    expect(fixtureReads).toBe(1);
  });

  it("captures an injected abstract operator id and callback once", () => {
    const testCase = createKernelCase(authorityFrom(prepared));
    let idReads = 0;
    let callbackReads = 0;
    const switching = new Proxy({ ...testCase.operator }, {
      get(target, property, receiver) {
        if (property === "operator_id") {
          idReads += 1;
          return idReads === 1 ? testCase.operator.operator_id : "decide_q";
        }
        if (property === "evaluate") {
          callbackReads += 1;
          return callbackReads === 1
            ? testCase.operator.evaluate
            : () => ({ status: "unsupported", reason: "injected" });
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const input = Object.freeze({ ...testCase.input, operator: switching });

    const result = evaluateAbstractProofKernel(input);

    expect(result.status).toBe("OPEN");
    expect(idReads).toBe(1);
    expect(callbackReads).toBe(1);
  });
  it("uses one verified authority capture for the complete proof operation", () => {
    const valid = authorityFrom(prepared);
    const baseline = createKernelCase(valid);
    let workspaceReads = 0;
    const switching = new Proxy({ ...valid }, {
      get(target, property, receiver) {
        if (property === "workspace_id") {
          workspaceReads += 1;
          return workspaceReads === 1 ? valid.workspace_id : "workspace-injected";
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const input = Object.freeze({ ...baseline.input, live_authority: switching });

    expect(evaluateAbstractProofKernel(input).status).toBe("OPEN");
    expect(workspaceReads).toBe(1);
  });

  it("compares against the captured proof after a later status switch", () => {
    const testCase = createKernelCase(authorityFrom(prepared));
    const oracle = enumerate(testCase.fixture, testCase.concrete);
    const proved = certifyAbstractSingletonWithFiniteOracle(testCase.input, oracle);
    if (proved.status !== "PROVED_SINGLETON") throw new Error("expected proof");
    let statusReads = 0;
    const switching = new Proxy({ ...proved }, {
      get(target, property, receiver) {
        if (property === "status") {
          statusReads += 1;
          return statusReads === 1 ? target.status : "OPEN";
        }
        return Reflect.get(target, property, receiver);
      }
    });

    expect(compareAbstractProofToOracle(testCase.input, switching, oracle))
      .toEqual({ false_singleton: false, missing_concrete_outcome_digests: [] });
    expect(statusReads).toBe(1);
  });

  it("captures operator evaluation before a later outcomes switch", () => {
    let outcomeReads = 0;
    const injected = Object.freeze([trace(["candidate-injected"], "injected")]);
    const testCase = createKernelCase(authorityFrom(prepared), {
      operator: Object.freeze({
        operator_id: "fixture_singleton_abstract_v1",
        evaluate: () => {
          let readsOnThis = 0;
          const evaluation = {
            status: "outcomes" as const,
            handled_sensitivity_ids: Object.freeze([] as const),
            outcomes: Object.freeze([trace(["candidate-a"], "singleton")])
          };
          return new Proxy(evaluation, {
            get(target, property, receiver) {
              if (property === "outcomes") {
                outcomeReads += 1;
                readsOnThis += 1;
                return readsOnThis === 1 ? target.outcomes : injected;
              }
              return Reflect.get(target, property, receiver);
            }
          });
        }
      })
    });

    const result = evaluateAbstractProofKernel(testCase.input);

    expect(result.status).toBe("OPEN");
    expect(result).toMatchObject({
      reason: "finite oracle differential certificate required"
    });
    if (result.status !== "OPEN") throw new Error("expected open");
    expect(result.possible_outcomes.map(({ candidate_prefix }) => [...candidate_prefix]))
      .toEqual([["candidate-a"]]);
    expect(outcomeReads).toBe(2);
  });
});

function enumerate(fixture: FiniteOracleFixture, operator: FiniteDecisionOperator) {
  return enumerateFiniteDecisionOracle({
    authority: authorityFrom(prepared), fixture, operator
  });
}

function membershipFixture(values: readonly boolean[] = [false, true]): FiniteOracleFixture {
  return {
    fixture_id: "abstract-membership",
    snapshot_digest: prepared.snapshotVector.vector_digest,
    k_max: 1,
    base_state: {},
    coordinates: [fixtureCoordinate("membership", "candidate_membership",
      "membership", values)]
  };
}

function membershipConcrete(): FiniteDecisionOperator {
  return Object.freeze({
    operator_id: "fixture_membership_concrete_v1",
    decide: ({ refinement }) => trace(
      refinement.assignments[0]?.value === true ? ["candidate-a"] : [],
      "membership"
    )
  });
}
