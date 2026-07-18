import { describe, expect, it } from "vitest";
import type { VerifiedRecallEvalPromotionEntryData } from "../../../longmemeval/promotion/verifiers/entry-verifier.js";
import {
  buildLongMemEvalMatrixPromotionAuthorization,
  LongMemEvalMatrixPromotionAuthorizationSchema
} from "../../../longmemeval/promotion/schema/authorization.js";
import { exactTwoSidedMcNemarPValue } from
  "../../../longmemeval/promotion/schema/material-effect.js";
import { buildEffectiveRecallConfigIdentity } from "../../../longmemeval/provenance/effective-recall-config.js";
import {
  authorizePromotionMatrixFixture as authorizeVerifiedLongMemEvalMatrix,
  matrixFixture,
  testCell
} from "./promotion-matrix-fixture.js";

describe("verified LongMemEval A/B/C/D plus B2 promotion", () => {
  it.each([
    ["policy shape", (data: VerifiedRecallEvalPromotionEntryData) => ({
      ...data,
      payload: { ...data.payload, policy_shape: "chat" as const }
    })],
    ["simulate report", (data: VerifiedRecallEvalPromotionEntryData) => ({
      ...data,
      payload: { ...data.payload, simulate_report: "gold-only" as const }
    })],
    ["weight overrides", (data: VerifiedRecallEvalPromotionEntryData) => ({
      ...data,
      payload: {
        ...data.payload,
        recall_weight_overrides: {
          source: "cli" as const,
          additive: { CONFIDENCE_DIRECT_WEIGHT: 0.5 }
        }
      }
    })],
    ["max results", (data: VerifiedRecallEvalPromotionEntryData) => {
      const custom = buildEffectiveRecallConfigIdentity({}, {
        maxResults: 25,
        conflictAwareness: true
      });
      const attribution = data.payload.recall_eval_attribution!;
      return {
        ...data,
        payload: {
          ...data.payload,
          recall_eval_attribution: { ...attribution, recall_config: custom }
        },
        provenance: {
          ...data.provenance,
          recall_config: { conf_slice_compatibility: false, ...custom }
        }
      };
    }],
    ["conflict awareness", (data: VerifiedRecallEvalPromotionEntryData) => {
      const custom = buildEffectiveRecallConfigIdentity({}, {
        maxResults: 10,
        conflictAwareness: false
      });
      const attribution = data.payload.recall_eval_attribution!;
      return {
        ...data,
        payload: {
          ...data.payload,
          recall_eval_attribution: { ...attribution, recall_config: custom }
        },
        provenance: {
          ...data.provenance,
          recall_config: { conf_slice_compatibility: false, ...custom }
        }
      };
    }],
    ["facet-tag seed capability", (data: VerifiedRecallEvalPromotionEntryData) => ({
      ...data,
      provenance: {
        ...data.provenance,
        seed_capabilities: { facet_tags_enabled: true }
      }
    })]
  ] as const)("rejects a unified custom %s across all four cells", (_label, mutate) => {
    const fixture = matrixFixture();
    const cells = fixture.cells.map((cell) =>
      testCell(cell.evidenceRoot, mutate(cell.data) as VerifiedRecallEvalPromotionEntryData));
    const productDefaultReplication = testCell(
      fixture.productDefaultReplication.evidenceRoot,
      mutate(fixture.productDefaultReplication.data) as VerifiedRecallEvalPromotionEntryData
    );

    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      cells,
      productDefaultReplication
    }))
      .toThrow(/product-default/u);
  });

  it("does not treat a diagnostic process exit code as authorization evidence", () => {
    const fixture = matrixFixture();
    const diagnosticOnly = {
      ...fixture,
      cells: [],
      productDefaultReplication: undefined,
      exitCode: 0
    };

    expect(() => authorizeVerifiedLongMemEvalMatrix(diagnosticOnly))
      .toThrow(/four verified cells/u);
  });

  it("requires an independently verified B2 product-default replication", () => {
    const fixture = matrixFixture();
    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      productDefaultReplication: undefined
    })).toThrow(/B2.*verified replication/u);

    const reusedBundle = {
      ...fixture.productDefaultReplication.data,
      manifest: {
        ...fixture.productDefaultReplication.data.manifest,
        bundle_sha256: fixture.cells[1]!.data.manifest.bundle_sha256
      }
    };
    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      productDefaultReplication: testCell("cell-b2", reusedBundle)
    })).toThrow(/independent.*bundle/u);
  });

  it("rejects B2 common-identity drift or reused run identity", () => {
    const fixture = matrixFixture();
    const drifted = {
      ...fixture.productDefaultReplication.data,
      provenance: {
        ...fixture.productDefaultReplication.data.provenance,
        dataset_sha256: "9".repeat(64)
      }
    } as VerifiedRecallEvalPromotionEntryData;
    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      productDefaultReplication: testCell("cell-b2", drifted)
    })).toThrow(/common evidence identity/u);

    const reusedRun = {
      ...fixture.productDefaultReplication.data,
      manifest: {
        ...fixture.productDefaultReplication.data.manifest,
        run: {
          ...fixture.productDefaultReplication.data.manifest.run,
          slug: fixture.cells[1]!.data.manifest.run.slug,
          run_at: fixture.cells[1]!.data.manifest.run.run_at
        }
      }
    };
    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      productDefaultReplication: testCell("cell-b2", reusedRun)
    })).toThrow(/independent.*run/u);
  });

  it("rejects evidence whose persisted run times violate A/B/C/D/B2 order", () => {
    const fixture = matrixFixture();
    const product = fixture.cells[1]!;
    const outOfOrder = {
      ...product.data,
      manifest: {
        ...product.data.manifest,
        run: {
          ...product.data.manifest.run,
          run_at: "2026-07-15T00:00:00.000Z"
        }
      }
    } as VerifiedRecallEvalPromotionEntryData;

    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      cells: fixture.cells.map((cell, index) =>
        index === 1 ? testCell(cell.evidenceRoot, outOfOrder) : cell)
    })).toThrow(/pre-registered A\/B\/C\/D\/B2 order/u);
  });

  it("rejects directional or statistically nonmaterial A-to-B results", () => {
    const fixture = matrixFixture();
    const product = fixture.cells[1]!;
    const regressed = {
      ...product.data,
      payload: {
        ...product.data.payload,
        kpi: { ...product.data.payload.kpi, r_at_1: 0.79 }
      }
    } as VerifiedRecallEvalPromotionEntryData;
    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      cells: fixture.cells.map((cell, index) =>
        index === 1 ? testCell(cell.evidenceRoot, regressed) : cell)
    })).toThrow(/regress/u);
  });

  it("signs independent B2 gates and the unpooled A-to-B material effect", () => {
    const authorization = authorizeVerifiedLongMemEvalMatrix(matrixFixture());

    expect(authorization.product_default_replication).toMatchObject({
      cell: "B2",
      evidence_root: "cell-b2",
      bundle_sha256: "5".repeat(64)
    });
    expect(authorization.product_default_replication.hard_gates.every(
      (gate) => gate.passed
    )).toBe(true);
    expect(authorization.material_effect.paired_r_at_5).toMatchObject({
      answerable_count: 94,
      control_hits: 80,
      product_hits: 89,
      gained: 9,
      lost: 0,
      net: 9,
      mcnemar: { method: "exact_two_sided", p_value: 0.00390625 }
    });
  });

  it("does not pool a different passing B2 outcome into the A-to-B effect", () => {
    const fixture = matrixFixture();
    const baseline = authorizeVerifiedLongMemEvalMatrix(fixture).material_effect;
    const b2 = fixture.productDefaultReplication;
    const rows = b2.data.payload.kpi.per_scenario.map((row, index) => ({
      ...row,
      hit_at_5: row.measurement_cohort === "answerable" && index < 88
    }));
    const quality = b2.data.payload.kpi.quality_metrics!;
    const changedPayload = {
      ...b2.data.payload,
      kpi: {
        ...b2.data.payload.kpi,
        r_at_5: 88 / 94,
        per_scenario: rows,
        quality_metrics: {
          ...quality,
          measurement_cohort_counts: {
            ...quality.measurement_cohort_counts!,
            hit_at_5: 88,
            miss_at_5: 6
          }
        }
      }
    } as VerifiedRecallEvalPromotionEntryData["payload"];
    const authorization = authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      productDefaultReplication: testCell(
        b2.evidenceRoot,
        { ...b2.data, payload: changedPayload }
      )
    });

    expect(authorization.material_effect).toEqual(baseline);
  });

  it("rejects a machine authorization changed after signing", () => {
    const authorization = authorizeVerifiedLongMemEvalMatrix(matrixFixture());
    const tampered = {
      ...authorization,
      material_effect: {
        ...authorization.material_effect,
        paired_r_at_5: {
          ...authorization.material_effect.paired_r_at_5,
          net: 10
        }
      }
    };

    expect(LongMemEvalMatrixPromotionAuthorizationSchema.safeParse(tampered).success)
      .toBe(false);
  });

  it("rejects paired hit counts that disagree with the signed R@5 effect", () => {
    const authorization = authorizeVerifiedLongMemEvalMatrix(matrixFixture());
    const { authorization_sha256: _digest, ...unsigned } = authorization;
    const paired = unsigned.material_effect.paired_r_at_5;

    expect(() => buildLongMemEvalMatrixPromotionAuthorization({
      ...unsigned,
      material_effect: {
        ...unsigned.material_effect,
        paired_r_at_5: { ...paired, control_hits: paired.control_hits + 1 }
      }
    })).toThrow(/paired material effect/u);
  });

  it("rejects more discordant pairs than the answerable cohort can contain", () => {
    const authorization = authorizeVerifiedLongMemEvalMatrix(matrixFixture());
    const { authorization_sha256: _digest, ...unsigned } = authorization;
    const directional = unsigned.material_effect.directional;

    expect(() => buildLongMemEvalMatrixPromotionAuthorization({
      ...unsigned,
      material_effect: {
        ...unsigned.material_effect,
        directional: {
          ...directional,
          r_at_5: { control: 1 / 94, product: 1, delta: 93 / 94 }
        },
        paired_r_at_5: {
          answerable_count: 94,
          control_hits: 1,
          product_hits: 94,
          gained: 94,
          lost: 1,
          net: 93,
          mcnemar: {
            method: "exact_two_sided",
            p_value: exactTwoSidedMcNemarPValue(94, 1)
          }
        }
      }
    })).toThrow(/paired material effect/u);
  });

  it("rejects paired margins that imply a negative contingency-table cell", () => {
    const authorization = authorizeVerifiedLongMemEvalMatrix(matrixFixture());
    const { authorization_sha256: _digest, ...unsigned } = authorization;
    const directional = unsigned.material_effect.directional;

    expect(() => buildLongMemEvalMatrixPromotionAuthorization({
      ...unsigned,
      material_effect: {
        ...unsigned.material_effect,
        directional: {
          ...directional,
          r_at_5: { control: 70 / 94, product: 90 / 94, delta: 20 / 94 }
        },
        paired_r_at_5: {
          answerable_count: 94,
          control_hits: 70,
          product_hits: 90,
          gained: 30,
          lost: 10,
          net: 20,
          mcnemar: {
            method: "exact_two_sided",
            p_value: exactTwoSidedMcNemarPValue(30, 10)
          }
        }
      }
    })).toThrow(/contingency table is impossible/u);
  });
});
