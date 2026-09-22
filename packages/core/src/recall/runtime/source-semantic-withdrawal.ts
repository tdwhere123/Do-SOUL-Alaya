import type { Derivation, SourceSemanticConsumedLeaf, SourceSemanticReasoningResult } from "@do-soul/alaya-protocol";
import { withdrawDerivationLeaves, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { localLeafIds, traceDerivationForest } from "../conditional-field/engine/derivation-provenance.js";

export type SourceSemanticWithdrawalTrace = Readonly<{
  contract: "source-semantic-withdrawal-trace-v1";
  origins: readonly Readonly<{ leaf_id: string; leaf: SourceSemanticConsumedLeaf }>[];
  derivations: readonly Derivation[];
  attempted: number; unattempted: number;
  prefix_resource_usage: Readonly<{ work_units: number; memory_bytes: number }>;
  arms: readonly Readonly<{ leaf_id: string; leaf: SourceSemanticConsumedLeaf; result: SourceSemanticReasoningResult;
    independent_answer_bindings: readonly string[]; independent_proofs_preserved: boolean | null }>[];
}>;

/** Every arm starts at the very same observed state; no admission, compilation or observation is repeated. */
export function traceSourceSemanticWithdrawals(input: Readonly<{
  state: FieldEngineState; origins: ReadonlyMap<string, SourceSemanticConsumedLeaf>;
  baseline: SourceSemanticReasoningResult; limit: number;
  prefix_resource_usage: Readonly<{ work_units: number; memory_bytes: number }>;
  project: (state: FieldEngineState, leaf_id?: string) => SourceSemanticReasoningResult;
}>): SourceSemanticWithdrawalTrace {
  const consumed = new Set(input.baseline.evidence_leaves?.map((row) => row.observation_id) ?? []);
  const candidates = [...input.origins].filter(([id, leaf]) => consumed.has(id)
    && (leaf.leaf_kind.startsWith("source_interpretation_") || leaf.leaf_kind.startsWith("semantic_correspondence_")));
  const interpretationLeaves = candidates.filter(([, leaf]) => leaf.leaf_kind.startsWith("source_interpretation_"));
  const correspondenceLeaves = candidates.filter(([, leaf]) => leaf.leaf_kind.startsWith("semantic_correspondence_"));
  // A bounded trial must not silently starve either semantic family.
  const selected = Array.from({ length: Math.max(interpretationLeaves.length, correspondenceLeaves.length) }, (_, index) => [interpretationLeaves[index], correspondenceLeaves[index]])
    .flat().filter((row): row is NonNullable<typeof row> => row !== undefined).slice(0, input.limit);
  const roots = new Map((input.baseline.derivations ?? []).map((row) => [row.derivation_id, row]));
  const dependencies = (input.baseline.answers ?? []).map((answer) => {
    const traced = traceDerivationForest({ forest: roots, roots: answer.explanation_ids });
    return { answer, complete: traced.complete,
      leaves: localLeafIds(traced.traversal) };
  });
  const arms = selected.map(([leaf_id, leaf]) => {
    const result = input.project(withdrawDerivationLeaves(input.state, leaf_id), leaf_id);
    const independent = dependencies.filter((row) => row.complete && row.answer.explanation_ids.length > 0
      && !row.leaves.has(leaf_id)).map((row) => row.answer);
    return { leaf_id, leaf, result, independent_answer_bindings: independent.map((row) => row.binding_id),
      independent_proofs_preserved: independent.length === 0 || result.outcome.status !== "interpreted" ? null
        : independent.every((answer) => result.answers?.some((row) => row.binding_id === answer.binding_id
          && JSON.stringify(row.explanation_ids) === JSON.stringify(answer.explanation_ids))) };
  });
  return { contract: "source-semantic-withdrawal-trace-v1",
    prefix_resource_usage: input.prefix_resource_usage,
    origins: [...input.origins].map(([leaf_id, leaf]) => ({ leaf_id, leaf })),
    derivations: [...input.state.derivations], attempted: arms.length, unattempted: candidates.length - arms.length, arms };
}
