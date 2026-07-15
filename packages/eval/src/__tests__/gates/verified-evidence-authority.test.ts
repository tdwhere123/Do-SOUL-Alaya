import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "../../schema/kpi-schema.js";
import { createLongMemEvalSelectionContractIdentity } from
  "../../schema/longmemeval-selection-contract.js";
import { verifiedLongMemEvalEvidenceMatches } from
  "../../gates/longmemeval-verified-evidence.js";
import {
  buildReleaseGradePublic,
  makeSeedExtractionPath
} from "./release-gates-fixture.js";
import { verifiedEvidenceForPayload } from "./verified-evidence-fixture.js";

describe("LongMemEval external dataset authority", () => {
  it("rejects a self-consistent KPI and archive reordered against dataset authority", async () => {
    const original = buildReleaseGradePublic(makeSeedExtractionPath());
    const datasetSha256 = original.dataset.checksum_sha256!;
    const authorityAssignments = original.kpi.per_scenario.map((row) => ({
      question_id: row.id,
      dataset_cohort: "answerable" as const
    }));
    const rows = [...original.kpi.per_scenario];
    [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    const payload = KpiPayloadSchema.parse({
      ...original,
      selection_contract: createLongMemEvalSelectionContractIdentity({
        datasetSha256,
        assignments: rows.map((row) => ({
          question_id: row.id,
          dataset_cohort: "answerable"
        }))
      }),
      kpi: { ...original.kpi, per_scenario: rows }
    });

    await expect(verifiedEvidenceForPayload(
      payload,
      authorityAssignments
    )).rejects.toThrow(/external dataset or selection identity differs/u);
  });
});

describe("LongMemEval verified payload identity", () => {
  it("normalizes typed payloads without honoring a custom toJSON method", async () => {
    const original = buildReleaseGradePublic(makeSeedExtractionPath());
    const context = await verifiedEvidenceForPayload(original);
    const changed = KpiPayloadSchema.parse({
      ...original,
      run_at: "2026-05-15T10:00:00.000Z"
    });
    const typedCaller = Object.assign(changed, {
      toJSON: () => original
    });

    expect(verifiedLongMemEvalEvidenceMatches(typedCaller, context)).toBe(false);
  });
});

describe("LongMemEval full diagnostics byte binding", () => {
  it("passes the hash-bound full diagnostics bytes to the required validator", async () => {
    const payload = buildReleaseGradePublic(makeSeedExtractionPath());
    let observedHash: string | null = null;

    await verifiedEvidenceForPayload(payload, undefined, ({ contents, payload: canonical }) => {
      observedHash = createHash("sha256").update(contents).digest("hex");
      expect(canonical).toEqual(KpiPayloadSchema.parse(payload));
    });

    expect(observedHash).toBe(
      createHash("sha256").update(new Uint8Array()).digest("hex")
    );
  });
});
