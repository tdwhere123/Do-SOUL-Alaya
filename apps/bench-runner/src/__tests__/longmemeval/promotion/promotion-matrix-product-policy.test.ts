import { describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  authorizePromotionMatrixFixture as authorizeVerifiedLongMemEvalMatrix,
  matrixFixture,
  testCell,
  withNonProductLocalBi,
  withOnnxThreads,
  withOpenAiEmbeddingProvider
} from "./promotion-matrix-fixture.js";

describe("verified LongMemEval A/B/C/D promotion", () => {
  it("authorizes the product-default B cell only after all mandatory gates pass", () => {
    const fixture = matrixFixture();
    const authorization = authorizeVerifiedLongMemEvalMatrix(fixture);

    expect(authorization).toMatchObject({
      status: "authorized",
      product_default: {
        cell: "B",
        treatment: { embedding_supplement: true, answer_rerank: false }
      },
      source_selection: { selected_count: 100 },
      next_selection: { selected_count: 500 }
    });
    expect(authorization.hard_gates.length).toBeGreaterThan(0);
    expect(authorization.hard_gates.every((gate) => gate.passed)).toBe(true);
    expect(authorization.authorization_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects shared snapshot drift even when every KPI remains passing", () => {
    const fixture = matrixFixture();
    const d = fixture.cells[3]!;
    const attribution = d.data.payload.recall_eval_attribution!;
    const driftedPayload = {
      ...d.data.payload,
      recall_eval_attribution: {
        ...attribution,
        snapshot_binding: {
          ...attribution.snapshot_binding,
          snapshot_manifest_sha256: "9".repeat(64)
        }
      }
    } as KpiPayload;
    const cells = fixture.cells.map((cell, index) =>
      index === 3
        ? testCell(cell.evidenceRoot, { ...cell.data, payload: driftedPayload })
        : cell);

    expect(() => authorizeVerifiedLongMemEvalMatrix({ ...fixture, cells }))
      .toThrow(/common evidence identity/u);
  });

  it("rejects non-treatment environment drift", () => {
    const fixture = matrixFixture();
    const d = fixture.cells[3]!;
    const drifted = {
      ...d.data,
      provenance: {
        ...d.data.provenance,
        runtime: {
          ...d.data.provenance.runtime,
          paired_env: {
            ...d.data.provenance.runtime.paired_env,
            ALAYA_RECALL_CONF_RHO_PATH: "0.99"
          }
        }
      }
    };
    const cells = fixture.cells.map((cell, index) =>
      index === 3 ? testCell(cell.evidenceRoot, drifted) : cell);

    expect(() => authorizeVerifiedLongMemEvalMatrix({ ...fixture, cells }))
      .toThrow(/common evidence identity/u);
  });

  it("rejects B/D bi-encoder model drift", () => {
    const fixture = matrixFixture();
    const d = fixture.cells[3]!;
    const cells = fixture.cells.map((cell, index) =>
      index === 3
        ? testCell(cell.evidenceRoot, withNonProductLocalBi(d.data, "custom_model"))
        : cell);

    expect(() => authorizeVerifiedLongMemEvalMatrix({ ...fixture, cells }))
      .toThrow(/B\/D bi-encoder model identity/u);
  });

  it("rejects a B latency hard-gate failure after successful evidence verification", () => {
    const fixture = matrixFixture();
    const b = fixture.cells[1]!;
    const failedPayload = {
      ...b.data.payload,
      kpi: { ...b.data.payload.kpi, latency_ms_p95: 1_101 }
    } as KpiPayload;
    const cells = fixture.cells.map((cell, index) =>
      index === 1
        ? testCell(cell.evidenceRoot, { ...cell.data, payload: failedPayload })
        : cell);

    expect(() => authorizeVerifiedLongMemEvalMatrix({ ...fixture, cells }))
      .toThrow(/failed hard gates.*recall_p95_embedding_on/u);
  });

  it("rejects a uniformly configured OpenAI matrix as non-product evidence", () => {
    const fixture = matrixFixture();
    const cells = fixture.cells.map((cell) =>
      testCell(cell.evidenceRoot, withOpenAiEmbeddingProvider(cell.data)));

    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      cells
    }))
      .toThrow(/product-default.*embedding/u);
  });

  it.each(["custom_model", "d2q"] as const)(
    "rejects a uniformly configured %s matrix as non-product evidence",
    (variant) => {
      const fixture = matrixFixture();
      const cells = fixture.cells.map((cell) =>
        testCell(cell.evidenceRoot, withNonProductLocalBi(cell.data, variant)));

      expect(() => authorizeVerifiedLongMemEvalMatrix({
        ...fixture,
        cells
      }))
        .toThrow(/product-default.*embedding/u);
    }
  );

  it("rejects a uniform ONNX thread override as non-product evidence", () => {
    const fixture = matrixFixture();
    const cells = fixture.cells.map((cell) =>
      testCell(cell.evidenceRoot, withOnnxThreads(cell.data, 64)));

    expect(() => authorizeVerifiedLongMemEvalMatrix({
      ...fixture,
      cells
    }))
      .toThrow(/product-default.*embedding/u);
  });
});
