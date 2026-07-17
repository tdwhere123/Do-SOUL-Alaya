import { describe, expect, it } from "vitest";
import type { VerifiedRecallEvalPromotionEntryData } from "../../../longmemeval/promotion/verifiers/entry-verifier.js";
import { LongMemEvalMatrixPromotionAuthorizationSchema } from "../../../longmemeval/promotion/schema/authorization.js";
import { buildEffectiveRecallConfigIdentity } from "../../../longmemeval/provenance/effective-recall-config.js";
import {
  authorizePromotionMatrixFixture as authorizeVerifiedLongMemEvalMatrix,
  matrixFixture,
  testCell
} from "./promotion-matrix-fixture.js";

describe("verified LongMemEval A/B/C/D promotion", () => {
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

    expect(() => authorizeVerifiedLongMemEvalMatrix({ ...fixture, cells }))
      .toThrow(/product-default/u);
  });

  it("does not treat a diagnostic process exit code as authorization evidence", () => {
    const fixture = matrixFixture();
    const diagnosticOnly = { ...fixture, cells: [], exitCode: 0 };

    expect(() => authorizeVerifiedLongMemEvalMatrix(diagnosticOnly))
      .toThrow(/four verified cells/u);
  });

  it("rejects a machine authorization changed after signing", () => {
    const authorization = authorizeVerifiedLongMemEvalMatrix(matrixFixture());
    const tampered = {
      ...authorization,
      product_default: {
        ...authorization.product_default,
        bundle_sha256: "9".repeat(64)
      }
    };

    expect(LongMemEvalMatrixPromotionAuthorizationSchema.safeParse(tampered).success)
      .toBe(false);
  });
});
