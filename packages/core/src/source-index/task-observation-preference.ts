import { compareUtcInstants, sourceEvidenceRootKey, sourceIndexNativeRootKey, SourceSemanticResourceExhausted,
  SourceTaskObservationProposalSchema,
  SourceSemanticResourceLedger, type QualifiedTaskObservation, type QuestionTimePreference,
  type SourceIndexAcquisitionResult, type SourceIndexQueryRepository, type SourceIndexRootNomination,
  type SourceSemanticNominationOccurrence, type SourceSemanticResourceBudget, type SourceEvidenceTarget, type SourceTaskObservation,
  type SourceTaskObservationProposal } from "@do-soul/alaya-protocol";
import type { SourcePreferenceRetention } from "./question-time-preference.js";
import { bindSourceTaskAssociation, TaskObservationFailure as ObservationFailure } from "./task-observation-binding.js";

export type TaskObservationInspection = Readonly<{
  status: "applied" | "unchanged" | "unknown" | "invalid" | "failed" | "unavailable";
  observed: number; preferred: number; producer_coverage?: "ready" | "partial";
  invalid?: number; unavailable?: number; reason?: string;
}>;

/** A source-bound query can inspect only that source within the native candidate union. */
export function taskObservationAllowsSource(source: SourceIndexRootNomination["source"], sourceId: string | undefined): boolean {
  return sourceId === undefined || source.source_id === sourceId;
}

/** The original prefix and paid incumbent are the only acquisition candidates for task evidence. */
export function taskObservationCandidates<N>(original: readonly (readonly [string, N])[], nominations: ReadonlyMap<string, N>): Map<string, N> {
  return new Map([...original, ...nominations.entries()]);
}

/** Optional partial task evidence is considered only within the already admitted bounded pools. */
export function preferTaskObservations<N extends SourceIndexRootNomination>(input: Readonly<{
  proposal: unknown; question: QuestionTimePreference; query: string;
  original: readonly (readonly [string, N])[]; nominations: Map<string, N>;
  occurrences: readonly SourceSemanticNominationOccurrence[]; max_roots: number;
  repository: SourceIndexQueryRepository; meter: SourceSemanticResourceLedger;
  association: SourceSemanticResourceBudget; retention: SourcePreferenceRetention;
  result: () => SourceIndexAcquisitionResult; nativeBytes: (bytes: number) => void;
  observe: (observation: TaskObservationInspection) => void;
}>): number | undefined {
  const capture = (rows: readonly N[], qualified: readonly QualifiedTaskObservation[], meter: SourceSemanticResourceLedger) => {
    const keys = new Set(rows.map(row => sourceIndexNativeRootKey(row.source)));
    return input.retention.retain({ result: { ...input.result(), nominations: rows },
      witness: input.occurrences.filter(row => keys.has(sourceIndexNativeRootKey(row.source))),
      question_time_order: [...keys], ...(qualified.length === 0 ? {} : { task_observations: qualified }) }, meter);
  };
  let retained = capture([...input.nominations.values()], [], input.meter);
  const child = new SourceSemanticResourceLedger({ work_units: Math.max(0, input.meter.work - input.association.work_units),
    memory_bytes: Math.max(0, input.meter.bytes - input.association.memory_bytes) });
  let observation: TaskObservationInspection = { status: "unknown", observed: 0, preferred: 0, reason: "source_task_funding" };
  try {
    const before = child.spentWork;
    child.retain(input.proposal, "source task proposal admission");
    child.charge(child.spentWork - before, 0, "source task proposal validation");
    const parsed = SourceTaskObservationProposalSchema.safeParse(input.proposal);
    if (!parsed.success) {
      observation = { status: "invalid", observed: 0, preferred: 0, reason: "malformed_observation" }; return retained;
    }
    const proposal = parsed.data;
    if (!("observations" in proposal)) {
      observation = { status: proposal.status, observed: 0, preferred: 0, reason: proposal.reason }; return retained;
    }
    if (compareUtcInstants(proposal.interpretation_clock, input.question.interpretation_clock) !== 0) {
      observation = { status: "invalid", observed: 0, preferred: 0, reason: "interpretation_clock_mismatch" }; return retained;
    }
    const size = input.original.length + input.nominations.size;
    child.charge(size + proposal.observations.length, (size + proposal.observations.length) * 64, "source task eligible pool");
    const candidates = taskObservationCandidates(input.original, input.nominations);
    const inspected = inspectTaskEvidence(proposal, candidates, input, child);
    observation = inspected.observation;
    const selected = inspected.selected;
    if (selected.size === 0) return retained;
    child.charge(size * size, size * 32, "source task preference order");
    const preferred = [...candidates].filter(([key]) => selected.has(key));
    const overlap = preferred.filter(([key]) => selected.get(key)!.temporal_relation === "hypothesized_overlap");
    const other = preferred.filter(([key]) => selected.get(key)!.temporal_relation !== "hypothesized_overlap");
    const rows = [...overlap, ...other, ...input.nominations.entries()].filter(([key], index, all) =>
      all.findIndex(([other]) => other === key) === index).slice(0, input.max_roots).map(([, row]) => row);
    const qualified = rows.flatMap(row => {
      const value = selected.get(sourceIndexNativeRootKey(row.source)); return value === undefined ? [] : [value];
    });
    const replacement = capture(rows, qualified, child);
    input.nominations.clear();
    for (const row of rows) input.nominations.set(sourceIndexNativeRootKey(row.source), row);
    retained = replacement;
    observation = { ...observation, status: "applied", preferred: qualified.length };
  } catch (error) {
    observation = { ...observation, status: error instanceof ObservationFailure ? error.status : "unknown",
      reason: error instanceof SourceSemanticResourceExhausted ? error.phase
        : error instanceof ObservationFailure ? error.reason : "source_task_failed_unknown_additional_cost" };
  } finally {
    input.meter.charge(child.spentWork, child.spentBytes, "source task optional inspection");
    input.observe(observation);
  }
  return retained;
}

function inspectTaskEvidence<N extends SourceIndexRootNomination>(
  proposal: Extract<SourceTaskObservationProposal, { observations: unknown }>, candidates: ReadonlyMap<string, N>,
  input: Readonly<{ question: QuestionTimePreference; query: string; repository: SourceIndexQueryRepository;
    retention: SourcePreferenceRetention; nativeBytes: (bytes: number) => void }>, meter: SourceSemanticResourceLedger
): { selected: Map<string, QualifiedTaskObservation>; observation: TaskObservationInspection } {
  const byIdentity = new Map([...candidates].map(entry => [taskSourceKey(entry[1].source.target, meter), entry]));
  const bindings = new Map<string, { source: N["source"]; rows: SourceTaskObservation[] }>();
  for (const row of proposal.observations) {
    const match = byIdentity.get(taskSourceKey(row.source, meter));
    if (match === undefined || !taskObservationAllowsSource(match[1].source, input.retention.source_id)) continue;
    const binding = bindings.get(match[0]);
    if (binding === undefined) bindings.set(match[0], { source: match[1].source, rows: [row] });
    else binding.rows.push(row);
  }
  const selected = new Map<string, QualifiedTaskObservation>();
  let observed = 0, invalid = 0, unavailable = 0, reason: string | undefined;
  for (const [key, binding] of bindings) {
    if (binding.rows.length !== 1) { invalid++; reason ??= "duplicate_source_observation"; continue; }
    const row = binding.rows[0]!;
    try {
      bindObservation(row, binding.source, input, meter);
      observed++;
      selected.set(key, bindSourceTaskAssociation({ row, proposal, query: input.query, question: input.question,
        reader: input.retention.readInterpretation, meter, nativeBytes: input.nativeBytes }));
    } catch (error) {
      if (!(error instanceof ObservationFailure) || error.reason.includes("unknown_additional_cost")) throw error;
      if (error.status === "invalid") invalid++; else unavailable++;
      reason ??= error.reason;
    }
  }
  return { selected, observation: { status: selected.size > 0 || invalid + unavailable === 0 ? "unchanged"
    : unavailable > 0 ? "unknown" : "invalid", observed, preferred: selected.size,
    producer_coverage: proposal.status, invalid, unavailable, ...(reason === undefined ? {} : { reason }) } };
}

function taskSourceKey(target: SourceEvidenceTarget, meter: SourceSemanticResourceLedger): string {
  const length = target.workspace_id.length + target.root_id.length + target.source_version.length +
    target.content_digest.length + (target.evidence_object_id?.length ?? 0);
  // JSON escaping can expand one UTF-16 unit into six ASCII units.
  meter.charge(32 + 12 * length, 512 + 32 * length, "source task identity binding");
  return sourceEvidenceRootKey(target);
}

function bindObservation(row: SourceTaskObservation, source: SourceIndexRootNomination["source"], input: Readonly<{
  question: QuestionTimePreference; query: string; repository: SourceIndexQueryRepository; nativeBytes: (bytes: number) => void;
}>, meter: SourceSemanticResourceLedger): void {
  const query = Buffer.from(input.query, "utf8"), quote = row.query_excerpt;
  meter.charge(query.length + quote.text.length, query.length * 2, "source task query binding");
  if (quote.end_byte > query.length || query.subarray(quote.start_byte, quote.end_byte).toString("utf8") !== quote.text) {
    throw new ObservationFailure("invalid", "query_excerpt_mismatch");
  }
  if (input.repository.readTaskObservation === undefined) throw new ObservationFailure("unknown", "source_task_reader_unavailable");
  const read = input.repository.readTaskObservation(source, row.source_excerpt, meter.remaining());
  input.nativeBytes(read.resources.native_bytes);
  meter.charge(read.resources.work, read.resources.memory_bytes, "source task native read");
  if (read.status !== "ready") throw new ObservationFailure("unknown", read.reason);
  if (read.text !== row.source_excerpt.text ||
      (read.source_observed_at === null ? row.source_observed_at !== null : row.source_observed_at === null ||
        compareUtcInstants(read.source_observed_at, row.source_observed_at) !== 0)) {
    throw new ObservationFailure("invalid", "source_excerpt_or_clock_mismatch");
  }
}
