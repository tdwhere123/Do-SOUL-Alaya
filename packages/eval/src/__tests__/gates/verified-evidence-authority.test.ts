import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "../../schema/kpi-schema.js";
import { createLongMemEvalSelectionContractIdentity } from
  "../../schema/longmemeval-selection-contract.js";
import { verifiedLongMemEvalEvidenceMatches } from
  "../../gates/longmemeval-verified-evidence.js";
import {
  verifyLongMemEvalEvidenceArtifactIntegrity,
  type LongMemEvalEvidenceArtifact
} from "../../gates/longmemeval-verified-evidence.js";
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
  it("accepts a single exact-500 full run without fanout artifacts", async () => {
    const payload = buildReleaseGradePublic(makeSeedExtractionPath());

    await expect(verifiedEvidenceForPayload(payload)).resolves.toBeDefined();
  });

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

describe("LongMemEval profile-specific evidence roles", () => {
  it("preserves the full-run role contract while allowing unrelated optional evidence", () => {
    const fixture = integrityFixture("full_run", [
      "kpi", "report", "diagnostics", "full_diagnostics", "cohort_ledger",
      "comparison", "run_provenance", "findings"
    ]);

    expect(verifyLongMemEvalEvidenceArtifactIntegrity(
      fixture.manifest,
      fixture.artifacts
    )).toEqual({ valid: true, errors: [] });
  });

  it("accepts exactly the recall-eval roles plus optional findings", () => {
    const fixture = integrityFixture("recall_eval", [
      "kpi", "report", "rank_identity", "run_provenance",
      "recall_eval_diagnostics", "findings"
    ]);

    expect(verifyLongMemEvalEvidenceArtifactIntegrity(
      fixture.manifest,
      fixture.artifacts
    )).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ["missing", ["kpi", "report", "rank_identity", "run_provenance"]],
    ["unexpected", [
      "kpi", "report", "rank_identity", "run_provenance",
      "recall_eval_diagnostics", "full_diagnostics"
    ]]
  ])("rejects a %s recall-eval role set", (_label, roles) => {
    const fixture = integrityFixture("recall_eval", roles);

    expect(verifyLongMemEvalEvidenceArtifactIntegrity(
      fixture.manifest,
      fixture.artifacts
    ).valid).toBe(false);
  });
});

function integrityFixture(
  profile: "full_run" | "recall_eval",
  roles: readonly string[]
): {
  readonly manifest: unknown;
  readonly artifacts: readonly LongMemEvalEvidenceArtifact[];
} {
  const selection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: "d".repeat(64),
    assignments: [{ question_id: "q-1", dataset_cohort: "answerable" }]
  });
  const artifacts = roles.map((role, index) => ({
    role,
    path: `${index}-${role}`,
    contents: `${role}\n`
  }));
  const unsigned = {
    schema_version: 1,
    kind: "longmemeval_evidence_bundle",
    profile,
    run: {
      slug: "profile-role-test",
      bench_name: "public",
      split: "longmemeval-s",
      run_at: "2026-07-16T00:00:00.000Z",
      alaya_commit: "abcdef0",
      dataset_sha256: selection.dataset_sha256,
      selection_manifest_sha256: null,
      question_id_digest: selection.selected_id_digest,
      selection_contract: selection,
      candidate_pool_complete: true,
      provenance_complete: true
    },
    evidence_status: "complete",
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      sha256: createHash("sha256").update(artifact.contents).digest("hex"),
      bytes: Buffer.byteLength(artifact.contents)
    }))
  };
  return {
    artifacts,
    manifest: {
      ...unsigned,
      bundle_sha256: createHash("sha256")
        .update(JSON.stringify(unsigned))
        .digest("hex")
    }
  };
}
