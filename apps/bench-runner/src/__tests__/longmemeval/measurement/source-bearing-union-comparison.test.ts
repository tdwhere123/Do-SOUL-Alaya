import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@do-soul/alaya-core";
import { readmitSourceSemanticLibraryMeasurement } from "../../../runs/measurement/source-semantic-library-measurement.js";
import { reportFrozenSourceBearingUnion } from "../../../runs/measurement/source-bearing-union-comparison.js";
import { LongMemEvalPublicationSchema, LongMemEvalSourceOnlyReplaySchema } from "../../../runs/longmemeval-semantic/execute.js";
import { envelope, frozenUnionFixture } from "./source-bearing-union-comparison-fixture.js";
afterEach(() => vi.restoreAllMocks());

describe("frozen source-bearing union evidence admission", () => {
  it("rejects published interpretations through the shared source-only publication admission", () => {
    const { evidence, read, files } = frozenUnionFixture();
    const preparedRow = evidence.prepared.payload.rows[0]!;
    const publication = JSON.parse(read(preparedRow.publication_path)).payload;
    publication.sources[0].publication = "published";
    expect(LongMemEvalPublicationSchema.safeParse(publication).success).toBe(false);
    const sealed = envelope(publication);
    files.set(preparedRow.publication_path, JSON.stringify(sealed));
    preparedRow.publication_identity = sealed.identity;
    evidence.prepared = envelope(evidence.prepared.payload);
    evidence.replay.payload.rows[0]!.publication_identity = sealed.identity;
    evidence.replay = envelope({ ...evidence.replay.payload, prepared_identity: evidence.prepared.identity });
    evidence.summary = envelope({ ...evidence.summary.payload, replay_identity: evidence.replay.identity });
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.rows[0]?.union_any_at_5).toBe("unavailable");
    expect(report.rows[0]?.cause).toContain("source-only publication");
  });

  it("rejects nonempty proofs in the source-only replay before evaluator verification", () => {
    const { evidence, read, files } = frozenUnionFixture();
    const path = evidence.replay.payload.rows[0]!.replay_path;
    const replay = JSON.parse(read(path)).payload;
    replay.rows[0].response.proofs = [{}];
    expect(LongMemEvalSourceOnlyReplaySchema.safeParse(replay).success).toBe(false);
    files.set(path, JSON.stringify(envelope(replay)));
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.rows[0]?.union_any_at_5).toBe("unavailable");
    expect(verify).not.toHaveBeenCalled();
  });
  it("records fresh source-only evaluation cost without inventing historical costs", () => {
    const { evidence, read } = frozenUnionFixture();
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.rows[0]?.union_any_at_5).toBe("hit");
    expect(verify).not.toHaveBeenCalled();
    expect(report.rows[0]?.evaluator_usage).toEqual({ proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 });
    expect(report.rows[20]?.evaluator_usage).toBeUndefined();
  });
  it("preserves the authored 500-row census and selected 20-question denominator", () => {
    const { evidence, read } = frozenUnionFixture();
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.rows).toHaveLength(500);
    expect(report.development_n).toBe(20);
    expect(report.bounds).toEqual({ hits: 3, unknown: 12, lower: 0.15, upper: 0.75 });
    expect(report.historical_mixed_primary).toEqual({ eligible: 20, hits: 3, misses: 5, unknown: 12 });
    expect(report.delivered_support).toBe("not_scored");
    expect(report.rows[8]?.stored_reason).toBe("native_measurement_unavailable");
  });

  it("rejects stale envelopes and question substitution even with a resealed summary", () => {
    const { evidence, read } = frozenUnionFixture();
    evidence.summary.payload.rows[3]!.measurement_path = evidence.summary.payload.rows[0]!.measurement_path;
    expect(() => reportFrozenSourceBearingUnion(evidence, read)).toThrow(/identity/u);
    evidence.summary = envelope(evidence.summary.payload);
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.bounds.hits).toBe(3);
    expect(report.rows[3]).toMatchObject({ union_any_at_5: "unavailable", cause: expect.stringContaining("question chain") });
  });

  it("restores omitted unknown rows and rejects a forged reduced denominator", () => {
    const { evidence, read } = frozenUnionFixture();
    evidence.summary.payload.rows = evidence.summary.payload.rows.filter((row) => row.outcome !== "unknown");
    evidence.summary = envelope(evidence.summary.payload);
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.rows).toHaveLength(500);
    expect(report.development_n).toBe(20);
    expect(report.bounds).toEqual({ hits: 3, unknown: 12, lower: 0.15, upper: 0.75 });
    evidence.summary.payload.primary.eligible = 8;
    evidence.summary = envelope(evidence.summary.payload);
    expect(() => reportFrozenSourceBearingUnion(evidence, read)).toThrow(/denominator/u);
  });

  it.each(["missing", "corrupt"] as const)("keeps %s measurement evidence unknown without aborting other rows", (kind) => {
    const { evidence, read, files } = frozenUnionFixture();
    const path = evidence.summary.payload.rows[0]!.measurement_path!;
    if (kind === "missing") files.delete(path); else files.set(path, "{broken");
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.development_n).toBe(20);
    expect(report.bounds).toMatchObject({ hits: 2, unknown: 13 });
    expect(report.rows[0]).toMatchObject({ union_any_at_5: "unavailable", cause: expect.stringContaining(kind === "missing" ? "missing_artifact" : "corrupt_json") });
  });

  it("does not promote an incomplete-source unknown to a miss", () => {
    const { evidence, read } = frozenUnionFixture();
    Object.assign(evidence.summary.payload.rows[3]!, { outcome: "unknown", reason: "source_or_gold_mapping_incomplete" });
    evidence.summary = envelope(evidence.summary.payload);
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.rows[3]).toMatchObject({ union_any_at_5: "unavailable", cause: "source_or_gold_mapping_incomplete" });
    expect(report.bounds).toMatchObject({ hits: 3, unknown: 13 });
  });

  it.each(["commitment", "identity", "index"] as const)("rejects tampered stored first-exposure %s", (kind) => {
    const { evidence, read } = frozenUnionFixture();
    const chain = JSON.parse(read(evidence.summary.payload.rows[0]!.measurement_path!));
    const measurement = chain.payload.rows[0].measurement;
    if (kind === "commitment") measurement.first_exposure_page.commitment = "f".repeat(64);
    else if (kind === "identity") measurement.first_exposure_page.initial.identity.query_id = "another-question";
    else measurement.delivered_index.query_id = "another-question";
    const replay = JSON.parse(read(evidence.replay.payload.rows[0]!.replay_path)).payload.rows[0];
    expect(readmitSourceSemanticLibraryMeasurement(measurement, { recallResult: replay.response,
      firstExposurePage: replay.first_exposure, requestBudget: evidence.freeze.payload.config.budget,
      goldSourceUnits: chain.payload.gold[0].source_units }).measurement?.status).toBe("invalid");
  });

  it.each(["results", "delivery"] as const)("rejects a resealed native replay with a different %s", (kind) => {
    const { evidence, read, files } = frozenUnionFixture();
    const path = evidence.replay.payload.rows[0]!.replay_path;
    const replay = JSON.parse(read(path));
    if (kind === "results") Object.assign(replay.payload.rows[0].response, { results: [], total_count: 0 });
    else replay.payload.rows[0].response.delivery_id = "another-delivery";
    files.set(path, JSON.stringify(envelope(replay.payload)));
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.rows[0]?.union_any_at_5).toBe("unavailable");
    expect(report.bounds).toMatchObject({ hits: 2, unknown: 13 });
  });

  it("rejects plans produced for a different frozen budget despite resealed outer envelopes", () => {
    const { evidence, read } = frozenUnionFixture();
    evidence.freeze = envelope({ ...evidence.freeze.payload, config: { ...evidence.freeze.payload.config,
      budget: { ...evidence.freeze.payload.config.budget, work_units: 200001 } } });
    evidence.prepared = envelope({ ...evidence.prepared.payload, freeze_identity: evidence.freeze.identity });
    evidence.replay = envelope({ ...evidence.replay.payload, freeze_identity: evidence.freeze.identity, prepared_identity: evidence.prepared.identity });
    evidence.summary = envelope({ ...evidence.summary.payload, freeze_identity: evidence.freeze.identity, replay_identity: evidence.replay.identity });
    const report = reportFrozenSourceBearingUnion(evidence, read);
    expect(report.bounds).toMatchObject({ hits: 0, unknown: 20 });
    expect(report.rows[0]?.cause).toContain("binding differs");
  });

  it.each(["provider_calls", "provider_attempts", "garden_enqueue", "request_budget", "missing_budget", "unknown_field"] as const)(
    "uses native response admission for resealed %s contradictions", (kind) => {
      const { evidence, read, files } = frozenUnionFixture();
      const path = evidence.replay.payload.rows[0]!.replay_path;
      const replay = JSON.parse(read(path)), response = replay.payload.rows[0].response;
      if (kind === "request_budget") response.request_budget.work_units = 7;
      else if (kind === "missing_budget") delete response.request_budget;
      else response[kind] = 1;
      files.set(path, JSON.stringify(envelope(replay.payload)));
      const report = reportFrozenSourceBearingUnion(evidence, read);
      expect(report.rows[0]).toMatchObject({ union_any_at_5: "unavailable", cause: expect.stringContaining("native response admission failed") });
      expect(report.bounds).toMatchObject({ hits: 2, unknown: 13 });
    });
});
