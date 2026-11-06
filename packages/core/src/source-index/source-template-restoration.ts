import { sourceIndexNativeRootKey, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  type SourceIndexAcquisitionResult, type SourceIndexQueryRepository, type SourceIndexRootNomination,
  type SourceSemanticNominationOccurrence, type SourceSemanticResourceBudget,
  type SourceTemplateProposal } from "@do-soul/alaya-protocol";
import { inspectSourceTemplate, type SourceTemplateInspection } from "./source-template-matching.js";

export type SourceTemplateRetention = Readonly<{
  /** Execute the actual mandatory capture once; a changed capture is separately charged. */
  retain: (capture: Readonly<{ result: SourceIndexAcquisitionResult;
    witness: readonly SourceSemanticNominationOccurrence[]; question_time_order: readonly string[] }>,
    meter: SourceSemanticResourceLedger) => number;
  source_id?: string;
}>;
export type SourceTemplateRestorationObservation = SourceTemplateInspection & Readonly<{
  restored: boolean; authorization: "admitted_prefix";
}>;

/** All baseline discovery has finished. Pay its actual retention before optional inspection,
 * then keep association finalization protected in a separately capped child allowance. */
export function restoreSourceTemplate<N extends SourceIndexRootNomination>(input: Readonly<{
  proposal: SourceTemplateProposal; original: readonly (readonly [string, N])[];
  nominations: Map<string, N>; occurrences: readonly SourceSemanticNominationOccurrence[];
  max_roots: number; repository: SourceIndexQueryRepository; meter: SourceSemanticResourceLedger;
  association: SourceSemanticResourceBudget; retention: SourceTemplateRetention;
  result: () => SourceIndexAcquisitionResult; nativeBytes: (bytes: number) => void;
  observe: (observation: SourceTemplateRestorationObservation) => void;
}>): number | undefined {
  if (input.nominations.size !== input.max_roots || !input.original.some(([key]) => !input.nominations.has(key))) return;
  const capture = (rows: readonly N[], meter: SourceSemanticResourceLedger): number => {
    const keys = new Set(rows.map(row => sourceIndexNativeRootKey(row.source)));
    return input.retention.retain({ result: { ...input.result(), nominations: rows },
      witness: input.occurrences.filter(row => keys.has(sourceIndexNativeRootKey(row.source))),
      question_time_order: [...keys] }, meter);
  };
  let retainedBytes = capture([...input.nominations.values()], input.meter);
  const child = new SourceSemanticResourceLedger({
    work_units: Math.max(0, input.meter.work - input.association.work_units),
    memory_bytes: Math.max(0, input.meter.bytes - input.association.memory_bytes)
  });
  let observation: SourceTemplateRestorationObservation = { status: "unknown", inspected_roots: 0,
    matched_roots: 0, restored: false, authorization: "admitted_prefix", reason: "source_template_funding" };
  try {
    child.charge(input.original.length, input.original.length * 16, "source template eligible prefix");
    const eligible = input.original.filter(([, row]) => input.retention.source_id === undefined
      || row.source.source_id === input.retention.source_id);
    const inspected = inspectSourceTemplate(input.proposal, eligible.map(([, row]) => row.source),
      input.repository, child, input.nativeBytes);
    observation = { ...inspected, restored: false, authorization: "admitted_prefix" };
    if (inspected.status !== "unique" || inspected.match === undefined
      || input.nominations.has(inspected.match.root_key)) return retainedBytes;
    const restored = eligible.find(([key]) => key === inspected.match!.root_key)!;
    child.charge(input.nominations.size + 1, (input.nominations.size + 1) * 16, "source template restored order");
    const rows = [restored[1], ...input.nominations.values()].slice(0, input.max_roots);
    const replacementBytes = capture(rows, child);
    // No selection changes until the entire replacement capture has been funded.
    input.nominations.clear();
    for (const row of rows) input.nominations.set(sourceIndexNativeRootKey(row.source), row);
    retainedBytes = replacementBytes;
    observation = { ...observation, restored: true };
  } catch (error) {
    observation = { ...observation, status: "unknown", reason: error instanceof SourceSemanticResourceExhausted
      ? error.phase : "source_template_restoration_failed_unknown_cost" };
  } finally {
    input.meter.charge(child.spentWork, child.spentBytes, "source template optional inspection");
    input.observe(observation);
  }
  return retainedBytes;
}
