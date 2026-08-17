import type { BenchName, BenchSplit, KpiPayload } from "@do-soul/alaya-eval";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "../harness/daemon.js";
import type {
  CompileSeedExtractionStats,
  CompileSeedRunner
} from "./compile-seed.js";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalEmbeddingVectorCacheSummary,
  LongMemEvalQueryEmbeddingCacheSummary
} from "./diagnostics.js";
import type { QaChatFn } from "./qa/qa-chat.js";

export type BenchEmbeddingVectorCacheSummary = LongMemEvalEmbeddingVectorCacheSummary;
export type BenchQueryEmbeddingCacheSummary = LongMemEvalQueryEmbeddingCacheSummary;

export interface BenchQaOption {
  readonly chat: QaChatFn;
  readonly judgeChat?: QaChatFn;
  readonly answerModel?: string;
  readonly judgeModel?: string;
}

export interface BenchRunOptions {
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly qa?: BenchQaOption;
}

export interface BenchRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string;
  readonly payload: KpiPayload;
}

export interface BenchCampaignIdentity {
  readonly benchName: BenchName;
  readonly split: BenchSplit;
  readonly diagnosticsFilename: string;
  readonly baselinePointerKind?: "run" | "passing";
}

export interface BenchPreparedCampaign<TUnit> {
  readonly dataset: readonly TUnit[];
  readonly window: readonly TUnit[];
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProvider: string;
  readonly seedRunner: CompileSeedRunner;
}

export interface BenchSeedRunnerInput<TUnit> {
  readonly window: readonly TUnit[];
  readonly offset: number;
  readonly requiredTurnContents: readonly string[];
}

export interface BenchWindowRunInput<TOpts extends BenchRunOptions, TUnit> {
  readonly window: readonly TUnit[];
  readonly opts: TOpts;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly seedRunner: CompileSeedRunner;
}

export interface BenchPayloadInput<
  TOpts extends BenchRunOptions,
  TUnit,
  TAggregate
> {
  readonly opts: TOpts;
  readonly dataset: readonly TUnit[];
  readonly window: readonly TUnit[];
  readonly aggregate: TAggregate;
  readonly runAt: Date;
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly embeddingProvider: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly extractionStats: CompileSeedExtractionStats;
}

export interface BenchPayloadBuild {
  readonly payload: KpiPayload;
  readonly diagnosticsPayload: LongMemEvalDiagnosticsSidecar;
}

/**
 * Dataset plug-in for runBenchCampaign. A third public bench is one adapter
 * file, not a second seed / recall / archive tree.
 */
export interface BenchCampaignAdapter<
  TOpts extends BenchRunOptions,
  TUnit,
  TAggregate
> {
  readonly identity: BenchCampaignIdentity;
  loadDataset(opts: TOpts): Promise<readonly TUnit[]>;
  collectRequiredTurnContents(window: readonly TUnit[]): readonly string[];
  createSeedRunner?(input: BenchSeedRunnerInput<TUnit>): CompileSeedRunner;
  runWindow(input: BenchWindowRunInput<TOpts, TUnit>): Promise<TAggregate>;
  buildPayload(
    input: BenchPayloadInput<TOpts, TUnit, TAggregate>
  ): BenchPayloadBuild;
  logExtractionStats?(stats: CompileSeedExtractionStats): void;
}
