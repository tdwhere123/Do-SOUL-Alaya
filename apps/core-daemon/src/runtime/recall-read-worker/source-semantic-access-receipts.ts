import { SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE, sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation,
  type SourceSemanticAccessPolicy, type SourceSemanticAccessReceipt, type SourceSemanticPreviewExtents } from "@do-soul/alaya-protocol";

type Stops = SourceSemanticAccessReceipt["stopping_reasons"];
type Pageable = Readonly<{
  observed_source_count: number; observed_interpretation_count: number;
  source_candidates: readonly unknown[]; interpretation_candidates: readonly unknown[];
}>;

/** The retained access receipt shape shared by observation and its conservative completion bound. */
export function sourceSemanticAccessReceiptValue<Source, Interpretation, Unvisited>(policy: SourceSemanticAccessPolicy, inputId: string,
  sources: readonly Source[], interpretations: readonly Interpretation[],
  unvisitedSources: Unvisited, unvisitedInterpretations: Unvisited, stops: Stops,
  sourcePreviewExtents?: SourceSemanticPreviewExtents,
  phases?: Pick<SourceSemanticAccessReceipt, "preparation" | "acquisition" | "phase_accounting">) {
  return { contract: "source-semantic-access-v2" as const,
    preparation: phases?.preparation ?? unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested"),
    acquisition: phases?.acquisition ?? sourceSemanticAcquisitionNotRun("controlled_or_scoped_access"),
    phase_accounting: phases?.phase_accounting ?? {
      observation: null,
      completion: "included_in_worker_work_not_separately_measured" as const,
      native_cpu: "unknown" as const, deadline: "soft_quarantine_until_exit" as const },
    policy, input_id: inputId,
    ...(sourcePreviewExtents === undefined ? {} : { source_preview_extents: sourcePreviewExtents }),
    observed_source_count: sources.length, observed_interpretation_count: interpretations.length,
    source_candidates: sources, interpretation_candidates: interpretations,
    unvisited_sources: unvisitedSources, unvisited_interpretations: unvisitedInterpretations,
    stopping_reasons: stops };
}

/** The delivered preparation trace shape; page sizing can request the full bounded source pool. */
export function preparationAccessReceiptValue<Access extends Pageable>(pool: Readonly<{ access: Access }>, sourceOffset: number,
  interpretationOffset: number, interpretationCount: number,
  sourceCount: number = SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) {
  const sourceRows = pool.access.source_candidates.slice(sourceOffset, sourceOffset + sourceCount);
  const interpretationRows = pool.access.interpretation_candidates.slice(interpretationOffset, interpretationOffset + interpretationCount);
  return { ...pool.access, source_candidates: sourceRows, interpretation_candidates: interpretationRows,
    trace: { kind: "preparation_page" as const, source_offset: sourceOffset, interpretation_offset: interpretationOffset,
      omitted_source_count: pool.access.observed_source_count - sourceRows.length,
      omitted_interpretation_count: pool.access.observed_interpretation_count - interpretationRows.length } };
}
