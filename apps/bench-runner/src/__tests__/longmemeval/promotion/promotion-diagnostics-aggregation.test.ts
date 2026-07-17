import { afterEach, describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { MAX_RECALL_EVAL_PROMOTION_QUESTION_BYTES } from "../../../longmemeval/promotion/artifacts/artifact-limits.js";
import {
  cleanupPromotionDiagnosticsFixtureRoots,
  fixtureEvidence,
  verifyFixture
} from "./promotion-diagnostics-fixture.js";

afterEach(cleanupPromotionDiagnosticsFixtureRoots);

describe("promotion-grade recall-eval diagnostics verification", () => {
  it("independently reaggregates a v2 diagnostics stream", async () => {
    const fixture = fixtureEvidence();

    await expect(verifyFixture(
      fixture.payload, fixture.diagnostics, fixture.rank, fixture.goldByQuestion
    ))
      .resolves.toMatchObject({ runtime: { embedding_supplement: { enabled: false } } });
  });

  it("rejects a question beyond the bound evidence count before row parsing", async () => {
    const fixture = fixtureEvidence();
    const document = JSON.parse(fixture.diagnostics) as { questions: unknown[] };
    document.questions.push({ invalid_extra_question: true });

    await expect(verifyFixture(
      fixture.payload,
      JSON.stringify(document),
      fixture.rank,
      fixture.goldByQuestion
    )).rejects.toThrow(/exceeds the bound evidence question count/u);
  });

  it("rejects one oversized question before schema parsing", async () => {
    const fixture = fixtureEvidence();
    const document = JSON.parse(fixture.diagnostics) as {
      questions: Array<Record<string, unknown>>;
    };
    document.questions[0]!.oversized = "x".repeat(
      MAX_RECALL_EVAL_PROMOTION_QUESTION_BYTES
    );

    await expect(verifyFixture(
      fixture.payload,
      JSON.stringify(document),
      fixture.rank,
      fixture.goldByQuestion
    )).rejects.toThrow(/question exceeds/u);
  });

  it("keeps dataset-declared abstention visible and outside answerable recall", async () => {
    const fixture = fixtureEvidence(true);

    expect(fixture.payload).toMatchObject({
      evaluated_count: 2,
      answerable_evaluated_count: 1,
      kpi: {
        r_at_5: 1,
        quality_metrics: { abstention: { total: 1, unscorable: 1 } }
      }
    });
    await expect(verifyFixture(
      fixture.payload, fixture.diagnostics, fixture.rank, fixture.goldByQuestion
    ))
      .resolves.toBeDefined();
  });

  it.each([
    ["latency", (payload: KpiPayload) => ({
      ...payload,
      kpi: { ...payload.kpi, latency_ms_p95: payload.kpi.latency_ms_p95 + 1 }
    })],
    ["token economy", (payload: KpiPayload) => ({
      ...payload,
      kpi: {
        ...payload.kpi,
        recall_token_economy: {
          ...payload.kpi.recall_token_economy!,
          embedding_inference_calls: {
            ...payload.kpi.recall_token_economy!.embedding_inference_calls,
            mean: 99
          }
        }
      }
    })],
    ["quality", (payload: KpiPayload) => ({
      ...payload,
      kpi: {
        ...payload.kpi,
        quality_metrics: {
          ...payload.kpi.quality_metrics!,
          no_gold_count: 1
        }
      }
    })]
  ] as const)("rejects KPI self-proof for %s", async (_label, mutate) => {
    const fixture = fixtureEvidence();
    const forged = mutate(fixture.payload) as KpiPayload;

    await expect(verifyFixture(
      forged, fixture.diagnostics, fixture.rank, fixture.goldByQuestion
    ))
      .rejects.toThrow(/independently recomputed/u);
  });

  it("rejects legacy v1 diagnostics as promotion evidence", async () => {
    const fixture = fixtureEvidence();
    const legacy = JSON.stringify({
      ...JSON.parse(fixture.diagnostics) as Record<string, unknown>,
      schema_version: 1
    });

    await expect(verifyFixture(
      fixture.payload, legacy, fixture.rank, fixture.goldByQuestion
    ))
      .rejects.toThrow(/schema_version/u);
  });

  it("rejects a producer-consistent nonzero treatment degradation", async () => {
    const fixture = fixtureEvidence(false, "warm_cascade_engaged");

    await expect(verifyFixture(
      fixture.payload,
      fixture.diagnostics,
      fixture.rank,
      fixture.goldByQuestion
    )).rejects.toThrow(/silently degraded/u);
  });

  it("rejects forged degradation aggregates", async () => {
    const fixture = fixtureEvidence();
    const forged = {
      ...fixture.payload,
      kpi: {
        ...fixture.payload.kpi,
        degradation_reasons: {
          ...fixture.payload.kpi.degradation_reasons,
          none: 1,
          warm_cascade_engaged: 1
        }
      }
    } as KpiPayload;

    await expect(verifyFixture(
      forged,
      fixture.diagnostics,
      fixture.rank,
      fixture.goldByQuestion
    )).rejects.toThrow(/independently recomputed/u);
  });
});
