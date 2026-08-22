import type { BenchSimulateReportMode } from "@do-soul/alaya-eval";
import type {
  BenchDaemonLaunchConfig
} from "../../../../harness/daemon/daemon-environment.js";
import type {
  BenchEmbeddingMode,
  BenchRecallOptions
} from "../../../../harness/daemon.js";
import type { BenchRecallWeightOverrides } from
  "../../../../harness/recall/recall-weight-overrides.js";
import type { RecallEvalOptions } from
  "../recall-eval-contract.js";
import type {
  EmbeddingCacheOverlayBinding,
  EmbeddingCacheOverlayExpectedSourceBinding
} from "../../../snapshot/recall-eval/embedding-cache-overlay/contract.js";
import type {
  LongMemEvalSnapshotManifest,
  LongMemEvalSnapshotQuestion
} from "../../../snapshot/materialize.js";
import type { SnapshotQuestionMeasurementOracle } from
  "../../../snapshot/measurement-oracle.js";
import type { RecallEvalSelectionBoundaryArtifact } from
  "../recall-eval-selection-replay.js";
import type { EvidenceSearchProjectionRebuildReport } from
  "../../../snapshot/recall-eval/evidence-search-projection-rebuild.js";

export type RecallEvalPagerRecallOptions = Omit<
  BenchRecallOptions,
  "selectionBoundaryObserver"
>;

export interface RecallEvalPagerOpenPayload {
  readonly dataDirRoot: string;
  readonly daemonLaunch: BenchDaemonLaunchConfig;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly options: RecallEvalOptions;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly overlayExpected: EmbeddingCacheOverlayExpectedSourceBinding | undefined;
  readonly sourceExtractionSystemPromptSha256: string | undefined;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly simulateReport: BenchSimulateReportMode;
  readonly captureOpenSemanticFactorCandidateActivations: boolean;
}

export interface RecallEvalPagerRecallPayload {
  readonly question: LongMemEvalSnapshotQuestion;
  readonly turnIndex: number;
  readonly recallOptions: RecallEvalPagerRecallOptions;
  readonly measurement: SnapshotQuestionMeasurementOracle | undefined;
}

export interface RecallEvalPagerOpenResult {
  readonly evidenceProjectionRebuild: EvidenceSearchProjectionRebuildReport | null;
  readonly embeddingCacheOverlay: EmbeddingCacheOverlayBinding | null;
}

export interface RecallEvalPagerCloseResult {
  readonly selectionArtifact: RecallEvalSelectionBoundaryArtifact | null;
}
