import type { ParsedFlags, ParsedFlagsState } from "./cli-options.js";

export function finalizeParsedFlags(state: ParsedFlagsState): ParsedFlags {
  const variantMap: Record<string, ParsedFlags["variant"]> = {
    oracle: "longmemeval_oracle",
    s: "longmemeval_s",
    m: "longmemeval_m",
    longmemeval_oracle: "longmemeval_oracle",
    longmemeval_s: "longmemeval_s",
    longmemeval_m: "longmemeval_m"
  };
  return {
    variant: variantMap[state.variantRaw] ?? "longmemeval_oracle",
    limit: state.limit,
    offset: state.offset,
    historyRoot: state.historyRoot,
    dataDir: state.dataDir,
    shards: state.shards.length > 0 ? state.shards : undefined,
    embeddingMode: state.embeddingMode,
    embeddingProviderKind: state.embeddingProviderKind,
    policyShape: state.policyShape,
    simulateReport: state.simulateReport,
    weightOverridesJson: state.weightOverridesJson,
    rounds: state.rounds,
    force: state.force,
    snapshot: state.snapshot,
    snapshotOut: state.snapshotOut,
    dataDirRoot: state.dataDirRoot,
    materializeQuestionDbs: state.materializeQuestionDbs,
    pinnedMetaRoot: state.pinnedMetaRoot,
    questionManifest: state.questionManifest,
    extractionCacheRoot: state.extractionCacheRoot,
    extractionAuthority: state.extractionAuthority,
    extractionTargetSelection: state.extractionTargetSelection,
    extractionPredecessorAuthority: state.extractionPredecessorAuthority,
    r3SpendApproval: state.r3SpendApproval,
    concurrency: state.concurrency,
    extractionInitialConcurrency: state.extractionInitialConcurrency,
    questionBatchLimit: state.questionBatchLimit,
    tolerateProviderTaskFailures: state.tolerateProviderTaskFailures,
    experiment: state.experiment,
    rebuildEvidenceSearchProjections: state.rebuildEvidenceSearchProjections,
    backfillMissingFactFrameFormations: state.backfillMissingFactFrameFormations,
    warmDerivedSnapshotReceipt: state.warmDerivedSnapshotReceipt,
    embeddingCacheOverlayReceipt: state.embeddingCacheOverlayReceipt,
    factFrameRetrofitLedger: state.factFrameRetrofitLedger,
    seedExtractionSystemPrompt: state.seedExtractionSystemPrompt,
    querySemanticFactorCache: state.querySemanticFactorCache,
    qa: state.qa,
    edgePlane: state.edgePlane,
    expectedReconciliationBasis: state.expectedReconciliationBasis,
    snapshotConsumeAuthority: state.snapshotConsumeAuthority
  };
}
