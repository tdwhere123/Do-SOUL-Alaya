import { z } from "zod";
import { validateQuestionMeasurementStatus } from
  "../../measurement/question-measurement-status.js";

export const DiagnosticRecallObjectKindSchema = z.enum([
  "memory_entry",
  "synthesis_capsule",
  "evidence_capsule"
]);

export const LongMemEvalGoldObjectKindSchema = z.enum([
  "memory_entry",
  "evidence_capsule"
]);

export function validatePersistedGoldIdentity(
  diagnostic: Readonly<{
    gold_memory_ids: readonly string[];
    gold_evidence_ids: readonly string[];
    gold_object_ids?: readonly string[];
  }>,
  context: z.RefinementCtx
): void {
  if (diagnostic.gold_object_ids === undefined) {
    if (diagnostic.gold_evidence_ids.length > 0) {
      context.addIssue({
        code: "custom",
        message: "evidence gold requires an explicit gold_object_ids union",
        path: ["gold_object_ids"]
      });
    }
    return;
  }
  const expected = [
    ...new Set([
      ...diagnostic.gold_memory_ids,
      ...diagnostic.gold_evidence_ids
    ])
  ];
  if (
    expected.length === diagnostic.gold_object_ids.length &&
    expected.every((id, index) => diagnostic.gold_object_ids?.[index] === id)
  ) return;
  context.addIssue({
    code: "custom",
    message: "gold_object_ids must be the stable memory-then-evidence union",
    path: ["gold_object_ids"]
  });
}

export function validatePersistedQuestionMeasurement(
  diagnostic: Parameters<typeof validatePersistedGoldIdentity>[0] & {
    readonly is_abstention: boolean;
    readonly cohort_ledger?: {
      readonly measurement_evidence_mode?: "legacy_synthesized";
      readonly measurement_status?: "scorable"
        | "abstention_unscorable"
        | "evaluator_identity_unscorable";
      readonly dataset_cohort: "answerable" | "abstention" | "adjudicated_invalid";
      readonly evaluator_gold_identity: {
        readonly status: "present" | "absent" | "ambiguous";
        readonly object_ids: readonly string[];
      };
      readonly extraction_materialization: {
        readonly status: "memory_emitted" | "evidence_preserved" | "drop" | "unknown";
        readonly emitted_memory_count: number;
        readonly reason: "candidate_absent" | "materialization_drop" | null;
      };
      readonly evaluation_issue_reason: string | null;
    };
  },
  context: z.RefinementCtx
): void {
  validatePersistedGoldIdentity(diagnostic, context);
  const ledger = diagnostic.cohort_ledger;
  if (ledger === undefined) return;
  validateMaterializationGoldKind(diagnostic, ledger.extraction_materialization, context);
  try {
    validateQuestionMeasurementStatus({
      isAbstention: diagnostic.is_abstention,
      legacyDiagnostic: ledger.measurement_evidence_mode === "legacy_synthesized",
      cohortLedger: ledger
    });
  } catch {
    context.addIssue({
      code: "custom",
      message: "persisted measurement status contradicts primitive axes",
      path: ["cohort_ledger", "measurement_status"]
    });
  }
}

function validateMaterializationGoldKind(
  diagnostic: Parameters<typeof validatePersistedGoldIdentity>[0],
  materialization: NonNullable<
    Parameters<typeof validatePersistedQuestionMeasurement>[0]["cohort_ledger"]
  >["extraction_materialization"],
  context: z.RefinementCtx
): void {
  if (materialization.status === "evidence_preserved" &&
      (diagnostic.gold_memory_ids.length > 0 ||
        diagnostic.gold_evidence_ids.length === 0)) {
    context.addIssue({
      code: "custom",
      message: "evidence_preserved requires evidence-only gold identity",
      path: ["cohort_ledger", "extraction_materialization", "status"]
    });
  }
  if (materialization.status === "memory_emitted" &&
      materialization.emitted_memory_count !== diagnostic.gold_memory_ids.length) {
    context.addIssue({
      code: "custom",
      message: "memory_emitted count must match gold_memory_ids",
      path: ["cohort_ledger", "extraction_materialization", "emitted_memory_count"]
    });
  }
}
