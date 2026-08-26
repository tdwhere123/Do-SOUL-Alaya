import type {
  BenchPolicyShape,
  BenchSimulateReportMode,
  EdgeProposalKpiEventRow,
  KpiPayload
} from "@do-soul/alaya-eval";
import type {
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchTokenMetrics
} from "../../../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../../../harness/recall/recall-diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from "../../diagnostics.js";
import type { LongMemEvalVariant } from "../../../longmemeval/ingestion/dataset.js";
import type { LongMemEvalSnapshotManifest } from "../../snapshot/materialize.js";
import type { LongMemEvalExpansionCapability } from
  "../../../longmemeval/promotion/expansion/expansion-capability.js";
import type { EvidenceSearchProjectionRebuildReport } from
  "../../snapshot/recall-eval/evidence-search-projection-rebuild.js";
import type { RecallEvalMemoryProfileCompletion } from
  "../../measurement/recall-eval-memory-profile.js";
import type { BoundedLifecycleFailure } from "../errors.js";
import type { SnapshotConsumeAuthority } from
  "../../snapshot/current/diagnostic-write-authority.js";
import type { BenchEmbeddingMode } from "../../../harness/daemon.js";

export interface RecallEvalOptions {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly historyRoot: string;
  readonly policyShape?: BenchPolicyShape;
  readonly simulateReport?: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  /** Override the restore directory in tests. */
  readonly dataDirRoot?: string;
  readonly legacySnapshot?: boolean;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly legacyManifestSha256?: string;
  readonly legacyDatasetSha256?: string;
  readonly experiment?: boolean;
  readonly derivedEvidenceProjectionRebuild?: boolean;
  readonly backfillMissingFactFrameFormations?: boolean;
  readonly warmDerivedSnapshotReceiptPath?: string;
  readonly embeddingCacheOverlayReceiptPath?: string;
  readonly factFrameRetrofitLedgerPath?: string;
  readonly seedExtractionSystemPromptPath?: string;
  readonly querySemanticFactorCachePath?: string;
  readonly querySemanticFactorCacheFileSha256?: string;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
  readonly snapshotConsumeAuthority?: SnapshotConsumeAuthority;
  readonly captureOpenSemanticFactorCandidateActivations?: boolean;
  readonly embeddingMode?: BenchEmbeddingMode;
}

export interface RecallEvalResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly payload: KpiPayload;
  readonly snapshotManifest: LongMemEvalSnapshotManifest;
  readonly perQuestionDelivered: ReadonlyMap<string, readonly string[]>;
  readonly completion: Readonly<{
    status: "complete" | "incomplete";
    failures: readonly BoundedLifecycleFailure[];
  }>;
  readonly memoryProfile: RecallEvalMemoryProfileCompletion;
  readonly derivedEvidenceProjectionRebuild?: EvidenceSearchProjectionRebuildReport;
}

export interface RecallEvalQuestionResult {
  readonly questionId: string;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  readonly tokenMetrics: BenchTokenMetrics;
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
  readonly edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  readonly documentEmbeddingWarmupLatencyMs: number | null;
  readonly deliveredObjectIds: readonly string[];
}
