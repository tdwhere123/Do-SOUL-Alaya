import { describe, expect, it } from "vitest";

import type { LongMemEvalDiagnosticsSidecar } from
  "../../../longmemeval/diagnostics.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";
import {
  classifyQuestionMeasurementCohort,
  classifyQuestionMeasurementStatus
} from
  "../../../longmemeval/measurement/question-validity.js";
import { validateQuestionMeasurementStatus } from
  "../../../longmemeval/measurement/question-measurement-status.js";
import { buildMergedLongMemEvalDiagnosticsSidecar } from
  "../../../cli/merge-sidecar.js";
import { question, streamedQuestion } from "./cli-merge-evidence-fixture.js";
import {
  makeShardDiagnostics,
  makeShardKpi
} from "./cli-merge-validations-fixture.js";

describe("legacy merge cohort boundary", () => {
  it("marks synthesized ledgers and excludes them from current measurement", () => {
    const { cohort_ledger: _currentLedger, ...legacyQuestion } = question("q-legacy");
    const shard = makeShardDiagnostics({ questions: [legacyQuestion] }) as
      unknown as LongMemEvalDiagnosticsSidecar;
    const merged = buildMergedLongMemEvalDiagnosticsSidecar(
      makeShardKpi(),
      [shard],
      { report_side_effects: null, scored_recall_evidence: null }
    );
    const diagnostic = merged.sidecar.questions[0]!;
    const ledger = diagnostic.cohort_ledger as
      Record<string, unknown> | undefined;

    expect(ledger?.measurement_evidence_mode).toBe("legacy_synthesized");
    expect(() => classifyQuestionMeasurementStatus(diagnostic))
      .toThrow(/legacy synthesized measurement evidence/u);
    expect(() => classifyQuestionMeasurementCohort(diagnostic))
      .toThrow(/legacy synthesized measurement evidence/u);
    expect(validateQuestionMeasurementStatus({
      isAbstention: diagnostic.is_abstention,
      legacyDiagnostic: true,
      cohortLedger: diagnostic.cohort_ledger!
    })).toBe("evaluator_identity_unscorable");
  });
});

describe("legacy merge cohort boundary", () => {
  it("keeps explicitly marked legacy diagnostics structurally readable", () => {
    const shard = makeShardDiagnostics({
      questions: [streamedQuestion("q-legacy-readable")]
    }) as unknown as LongMemEvalDiagnosticsSidecar;
    const diagnostic = buildMergedLongMemEvalDiagnosticsSidecar(
      makeShardKpi(),
      [shard],
      { report_side_effects: null, scored_recall_evidence: null }
    ).sidecar.questions[0]!;

    expect(LongMemEvalQuestionDiagnosticSchema.safeParse(diagnostic).success)
      .toBe(true);
  });
});

describe("legacy merge cohort boundary", () => {
  it("marks ledgers synthesized by an older merge before current classification", () => {
    const { cohort_ledger: _currentLedger, ...legacyQuestion } = question("q-old-merge");
    const firstMerge = buildMergedLongMemEvalDiagnosticsSidecar(
      makeShardKpi(),
      [makeShardDiagnostics({ questions: [legacyQuestion] }) as unknown as
        LongMemEvalDiagnosticsSidecar],
      { report_side_effects: null, scored_recall_evidence: null }
    ).sidecar.questions[0]!;
    const { measurement_evidence_mode: _marker, ...oldLedger } =
      firstMerge.cohort_ledger!;
    const oldMergedQuestion = { ...firstMerge, cohort_ledger: oldLedger };

    const diagnostic = buildMergedLongMemEvalDiagnosticsSidecar(
      makeShardKpi(),
      [makeShardDiagnostics({ questions: [oldMergedQuestion] }) as unknown as
        LongMemEvalDiagnosticsSidecar],
      { report_side_effects: null, scored_recall_evidence: null }
    ).sidecar.questions[0]!;

    expect(diagnostic.cohort_ledger?.measurement_evidence_mode)
      .toBe("legacy_synthesized");
    expect(() => classifyQuestionMeasurementStatus(diagnostic))
      .toThrow(/legacy synthesized measurement evidence/u);
    expect(() => classifyQuestionMeasurementCohort(diagnostic))
      .toThrow(/legacy synthesized measurement evidence/u);
  });
});
