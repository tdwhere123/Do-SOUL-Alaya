import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  collapseMeasurementGroup,
  collapsePropositionStateMeasurement,
  compareCollapsedPropositionStatesExact,
  issueMeasurementGroupAdmission,
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
  prepareLexicalMeasurementAuthorityFixture,
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture,
  withCapturedLexicalMeasurementAuthorityFixture
} from "./prepared-authority-fixture.js";

let prepared: PreparedRecallRequest;

describe("measurement admission", () => {
  beforeAll(async () => {
    prepared = await prepareMeasurementEvidenceFixture();
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

  it("binds the admission to contract, schema, and collapsed witness bytes", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-1", normalized_rank: 1 }],
      (authority) => {
        const collapse = numericCollapse(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT, authority);
        const admission = issueMeasurementGroupAdmission({
          authority,
          contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
          proposition_schema: "lex.interval",
          collapse
        });
        expect(validateMeasurementAdmissionV1({
          admission, current_authorities: [authority],
          contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
          proposition_schema: "lex.interval", collapse
        })).toEqual({ status: "admitted" });
        for (const candidate of [
          { admission, current_authorities: [authority], proposition_schema: "lex.interval.drifted" },
          { admission: { ...admission }, current_authorities: [authority],
            proposition_schema: "lex.interval" },
          { admission, current_authorities: [], proposition_schema: "lex.interval" },
          { admission, current_authorities: [{ ...authority } as typeof authority],
            proposition_schema: "lex.interval" }
        ]) {
          expect(validateMeasurementAdmissionV1({
            ...candidate,
            contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
            collapse
          }).status).toBe("blocked");
        }
      }
    );
  });

  it("rejects counterfeit authority capabilities and coordinate self-authorization", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-1", normalized_rank: 1 }],
      (authority) => {
        const collapse = numericCollapse(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT, authority);
        expect(() => issueMeasurementGroupAdmission({
          authority: { ...authority } as typeof authority,
          contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
          proposition_schema: "lex.interval", collapse
        })).toThrow(/not verified/u);
        expect(() => issueMeasurementGroupAdmission({
          authority: {
            query_id: collapse.witness.identity.query_id,
            snapshot_digest: collapse.witness.identity.snapshot_digest
          } as unknown as typeof authority,
          contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
          proposition_schema: "lex.interval", collapse
        })).toThrow(/not verified/u);
      }
    );
  });

  it("does not expose a prepared-only measurement authority issuer", async () => {
    const measurement = await import(
      "../../../../recall/shadow/measurement/index.js"
    );
    expect("verifyMeasurementPreparedAuthorityV1" in measurement).toBe(false);
  });

  it("rejects stripped and modified finalized lease capabilities", async () => {
    const evidence = measurementEvidence(prepared, true);
    expect(evidence.snapshot_read_lease.capabilities.length).toBeGreaterThan(0);
    await expect(prepareLexicalMeasurementAuthorityFixture(prepared, {
        ...evidence,
        snapshot_read_lease: {
          ...evidence.snapshot_read_lease,
          capabilities: []
        }
    })).rejects.toThrow();
    const first = evidence.snapshot_read_lease.capabilities[0]!;
    await expect(prepareLexicalMeasurementAuthorityFixture(prepared, {
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
    })).rejects.toThrow();
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

function numericCollapse(
  contract: Parameters<typeof collapseMeasurementGroup>[0]["contract"],
  authority: Parameters<typeof issueMeasurementGroupAdmission>[0]["authority"]
) {
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
      provenance: [{
        source_id: "lexical.interval.primary",
        producer: "lexical.interval.adapter.v1"
      }],
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
