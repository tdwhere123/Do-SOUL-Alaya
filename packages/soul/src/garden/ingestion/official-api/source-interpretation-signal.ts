import {
  CandidateMemorySignalSchema,
  SignalKind,
  SignalSource,
  SOURCE_INTERPRETATION_CONTRACT,
  type CandidateMemorySignal,
  type SourceInterpretationSignal,
  type SourceLocatedInterpretation
} from "@do-soul/alaya-protocol";

export function buildSourceInterpretationSignal(input: Readonly<{
  readonly located: SourceLocatedInterpretation;
  readonly workspaceId: string;
  readonly runId: string;
  readonly surfaceId: string | null;
  readonly signalId: string;
  readonly createdAt: string;
  readonly sourceObservation: NonNullable<CandidateMemorySignal["source_observation"]>;
  readonly scopeHint?: string | null;
}>): SourceInterpretationSignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: input.signalId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    surface_id: input.surfaceId,
    source: SignalSource.GARDEN_COMPILE,
    signal_kind: SignalKind.POTENTIAL_SEMANTIC_OBSERVATION,
    interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
    object_kind: null,
    confidence: null,
    scope_hint: input.scopeHint ?? null,
    domain_tags: [],
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { source_interpretation: input.located },
    source_observation: input.sourceObservation,
    created_at: input.createdAt
  }) as SourceInterpretationSignal;
}

export function emitLocatedInterpretationSignals(input: Readonly<{
  readonly located: readonly SourceLocatedInterpretation[];
  readonly workspaceId: string;
  readonly runId: string;
  readonly surfaceId: string | null;
  readonly createdAt: string;
  readonly sourceObservation: NonNullable<CandidateMemorySignal["source_observation"]>;
  readonly generateSignalId: () => string;
  readonly scopeHint?: string | null;
}>): readonly CandidateMemorySignal[] {
  return Object.freeze(input.located.flatMap((located) => {
    if (located.outcome === "empty") return [];
    return [buildSourceInterpretationSignal({
      located,
      workspaceId: input.workspaceId,
      runId: input.runId,
      surfaceId: input.surfaceId,
      signalId: input.generateSignalId(),
      createdAt: input.createdAt,
      sourceObservation: input.sourceObservation,
      ...(input.scopeHint === undefined ? {} : { scopeHint: input.scopeHint })
    })];
  }));
}
