import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  collapseMeasurementGroup,
  collapsePropositionStateMeasurement,
  compareCollapsedPropositionStatesExact,
  createMeasurementGroupContractV1,
  issueMeasurementGroupAdmission,
  verifyMeasurementPreparedAuthorityV1,
  validateMeasurementAdmissionV1
} from "../../../../recall/shadow/measurement/index.js";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import {
  createFourValuedWitness,
  createNumericIntervalWitness,
  type FourValuedPolarity,
  type WitnessEpistemic
} from "../../../../recall/shadow/witness/index.js";
import { PINS, PROV } from "../witness/fixtures.js";
import {
  measurementEvidence,
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture
} from "./prepared-authority-fixture.js";

let prepared: PreparedRecallRequest;
let authority: ReturnType<typeof verifyMeasurementPreparedAuthorityV1>;

describe("measurement admission", () => {
  beforeAll(async () => {
    prepared = await prepareMeasurementEvidenceFixture();
    authority = verifyMeasurementPreparedAuthorityV1({
      evidence: measurementEvidence(prepared, true),
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT
    });
  });

  afterAll(() => releaseMeasurementEvidenceFixture(prepared));

  it("keeps every Band0 D1 dependency type-only", () => {
    const files = [
      "../../../../recall/shadow/canonical-delivery.ts",
      "../../../../recall/shadow/integrate.ts",
      "../../../../recall/shadow/live-receipt-materialization.ts",
      "../../../../recall/shadow/measurement/lexical-interval-envelope.ts",
      "../../../../recall/shadow/measurement/lexical-interval.ts",
      "../../../../recall/shadow/psi-v2/compare.ts",
      "../../../../recall/shadow/psi-v2/from-envelope.ts",
      "../../../../recall/shadow/psi-v2/lexical-interval-adapter.ts",
      "../../../../recall/shadow/psi-v2/types.ts"
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(
        /import\s+([\s\S]*?)\s+from\s+"\.\.\/d1\/[^"]+";/gu
      )];
      expect(imports.every((match) => match[1]?.trimStart().startsWith("type ")))
        .toBe(true);
    }
  });

  it("keeps D1 runtime ownership in Band0 and Band1 contracts lexically named", () => {
    const d1Owner = readFileSync(new URL(
      "../../../../recall/shadow/d1/legal-envelope.ts",
      import.meta.url
    ), "utf8");
    const lexicalInterval = readFileSync(new URL(
      "../../../../recall/shadow/measurement/lexical-interval-envelope.ts",
      import.meta.url
    ), "utf8");

    expect(d1Owner).not.toMatch(/from\s+"\.\.\/measurement\//u);
    expect(d1Owner).toMatch(/export\s+function\s+d1LaneEnvelopes/u);
    expect(lexicalInterval).not.toMatch(/export\s+(?:type|function|const)\s+D1/u);
    expect(lexicalInterval).not.toMatch(/export\s+function\s+d1/u);
    expect(lexicalInterval).toMatch(
      /export\s+function\s+lexicalIntervalSourceEnvelopes/u
    );
  });

  it("rejects a structurally identical counterfeit contract", () => {
    const counterfeit = {
      ...LEXICAL_INTERVAL_MEASUREMENT_CONTRACT
    } as typeof LEXICAL_INTERVAL_MEASUREMENT_CONTRACT;
    expect(() => verifyMeasurementPreparedAuthorityV1({
      evidence: measurementEvidence(prepared, true),
      contract: counterfeit,
    })).toThrow(/predeclared/u);
  });

  it("rejects unknown digest-correct contracts and semantic drift", () => {
    const unknown = createMeasurementGroupContractV1({
      ...LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      contract_id: "measure.lexical.interval.unknown.v1"
    });
    const drifted = createMeasurementGroupContractV1({
      ...LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval.drifted"
    });
    for (const contract of [unknown, drifted]) {
      expect(() => verifyMeasurementPreparedAuthorityV1({
        evidence: measurementEvidence(prepared, true),
        contract,
      })).toThrow(/predeclared/u);
    }
  });

  it("binds the admission to contract, schema, and collapsed witness bytes", () => {
    const collapse = numericCollapse(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT);
    const admission = issueMeasurementGroupAdmission({
      authority,
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval",
      collapse
    });
    expect(validateMeasurementAdmissionV1({
      admission,
      current_authorities: [authority],
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval",
      collapse
    })).toEqual({ status: "admitted" });
    expect(validateMeasurementAdmissionV1({
      admission,
      current_authorities: [authority],
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval.drifted",
      collapse
    }).status).toBe("blocked");
    expect(validateMeasurementAdmissionV1({
      admission: { ...admission },
      current_authorities: [authority],
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval",
      collapse
    }).status).toBe("blocked");
    expect(validateMeasurementAdmissionV1({
      admission,
      current_authorities: [],
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval",
      collapse
    })).toEqual({
      status: "blocked",
      reason: "measurement admission is not bound to current verified authority"
    });
    expect(validateMeasurementAdmissionV1({
      admission,
      current_authorities: [{ ...authority } as typeof authority],
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval",
      collapse
    }).status).toBe("blocked");
  });

  it("rejects counterfeit authority capabilities and coordinate self-authorization", () => {
    const collapse = numericCollapse(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT);
    expect(() => issueMeasurementGroupAdmission({
      authority: { ...authority } as typeof authority,
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval",
      collapse
    })).toThrow(/not verified/u);
    expect(() => issueMeasurementGroupAdmission({
      authority: {
        query_id: collapse.witness.identity.query_id,
        snapshot_digest: collapse.witness.identity.snapshot_digest
      } as unknown as typeof authority,
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: "lex.interval",
      collapse
    })).toThrow(/not verified/u);
  });

  it("does not turn arbitrary prepared strings into a verified authority", () => {
    expect(() => verifyMeasurementPreparedAuthorityV1({
      evidence: {
        workspace_id: "invented-workspace",
        query_condition: { identity: "invented-query" },
        canonical_query_compilation: { digest: `sha256:${"a".repeat(64)}` },
        snapshot_vector: { vector_digest: `sha256:${"b".repeat(64)}` },
        snapshot_coherence_receipt: { receipt_digest: `sha256:${"c".repeat(64)}` },
        snapshot_read_lease: { state: "finalized", capabilities: [] }
      } as unknown as Parameters<typeof verifyMeasurementPreparedAuthorityV1>[0]["evidence"],
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT
    })).toThrow();
    const evidence = measurementEvidence(prepared, true);
    expect(() => verifyMeasurementPreparedAuthorityV1({
      evidence: {
        ...evidence,
        query_condition: {
          ...evidence.query_condition,
          identity: `sha256:${"f".repeat(64)}`
        }
      },
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT
    })).toThrow(/query condition/u);
  });

  it("rejects stripped and modified finalized lease capabilities", () => {
    const evidence = measurementEvidence(prepared, true);
    expect(evidence.snapshot_read_lease.capabilities.length).toBeGreaterThan(0);
    expect(() => verifyMeasurementPreparedAuthorityV1({
      evidence: {
        ...evidence,
        snapshot_read_lease: {
          ...evidence.snapshot_read_lease,
          capabilities: []
        }
      },
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT
    })).toThrow(/lease/u);
    const first = evidence.snapshot_read_lease.capabilities[0]!;
    expect(() => verifyMeasurementPreparedAuthorityV1({
      evidence: {
        ...evidence,
        snapshot_read_lease: {
          ...evidence.snapshot_read_lease,
          capabilities: [{
            ...first,
            declaration: {
              ...first.declaration,
              generation: `${first.declaration.generation}:modified`
            }
          }, ...evidence.snapshot_read_lease.capabilities.slice(1)]
        }
      },
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT
    })).toThrow(/lease/u);
  });
});

describe("exact proposition-state measurement", () => {
  it.each([
    ["supported_only", "supported_only", "eq"],
    ["refuted_only", "refuted_only", "eq"],
    ["supported_only", "refuted_only", "incomparable"],
    ["refuted_only", "supported_only", "incomparable"],
    ["unknown", "supported_only", "blocked"],
    ["both", "supported_only", "blocked"]
  ] as const)("compares %s and %s as %s", (left, right, expected) => {
    expect(compareCollapsedPropositionStatesExact(
      propositionCollapse("left", left),
      propositionCollapse("right", right)
    )).toBe(expected);
  });

  it("blocks unavailable inputs and mixed exact states", () => {
    expect(collapsePropositionStateMeasurement({
      contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
      observations: [proposition("a", "supported_only", { kind: "unavailable" })]
    }).status).toBe("blocked");
    expect(collapsePropositionStateMeasurement({
      contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
      observations: [
        proposition("a", "supported_only"),
        proposition("b", "refuted_only")
      ]
    }).status).toBe("blocked");
  });
});

function numericCollapse(contract: Parameters<typeof collapseMeasurementGroup>[0]["contract"]) {
  return collapseMeasurementGroup({
    contract,
    observations: [createNumericIntervalWitness({
      identity: {
        ...PINS,
        coordinate_id: "raw:lex",
        query_id: authority.query_id,
        snapshot_digest: authority.snapshot_digest,
        proposition_id: "lex.interval"
      },
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { lower: 1, upper: 1 }
    })]
  });
}

function propositionCollapse(candidate: string, polarity: FourValuedPolarity) {
  return collapsePropositionStateMeasurement({
    contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
    observations: [proposition(candidate, polarity)]
  });
}

function proposition(
  candidate: string,
  polarity: FourValuedPolarity,
  epistemic: WitnessEpistemic = polarity === "both"
    ? { kind: "conflict" }
    : { kind: "exact" }
) {
  return createFourValuedWitness({
    identity: {
      ...PINS,
      coordinate_id: `raw:${candidate}`,
      candidate_id: candidate,
      proposition_id: "prop-1"
    },
    provenance: PROV,
    epistemic,
    payload: epistemic.kind === "exact" || epistemic.kind === "conflict"
      ? { polarity }
      : null
  });
}
