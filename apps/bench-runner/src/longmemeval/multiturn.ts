import type { KpiPayload } from "@do-soul/alaya-eval";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchTokenMetrics
} from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from "./diagnostics.js";
import type { LongMemEvalVariant } from "./dataset.js";
import type { FetchResult } from "./fetch.js";
import type { LongMemEvalSidecarEntry } from "./runner-helpers.js";
import {
  prepareMultiturnRun,
  executeMultiturnRun
} from "./multiturn-run.js";
import {
  buildMultiturnPayload,
  writeMultiturnArtifacts
} from "./multiturn-payload.js";

export interface LongMemEvalMultiturnRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
  readonly rounds?: number;
  // Override the extraction-cache root the run-start preflight validates
  // against (test-only). Production callers leave undefined for the canonical
  // EXTRACTION_CACHE_ROOT; tests point it at an isolated dir to decouple from
  // the committed production manifest model.
  readonly extractionCacheRoot?: string;
}

export interface LongMemEvalMultiturnRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
}

export type SidecarEntry = LongMemEvalSidecarEntry;

export interface RoundResult {
  readonly roundIndex: number;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  // Per-recall token-economy sample for this round; null when the degraded
  // recall path (any non-null degradation_reason) omits the
  // token_economy block in core, so the bench extractor returns null and
  // degraded rounds don't dilute the run-level distribution.
  // see also: packages/core/src/recall/recall-service.ts
  // (computeRecallTokenEconomy call site).
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
}

export interface QuestionResult {
  readonly questionId: string;
  readonly rounds: readonly RoundResult[];
  readonly seedTurnsTruncated: number;
  readonly answerTurnsTruncated: number;
  readonly seedCharsClipped: number;
  readonly tokenMetrics: BenchTokenMetrics;
}

export async function runLongMemEvalMultiturn(
  opts: LongMemEvalMultiturnRunOptions
): Promise<LongMemEvalMultiturnRunResult> {
  const context = await prepareMultiturnRun(opts);
  const execution = await executeMultiturnRun(context);
  const payloadBuild = buildMultiturnPayload(context, execution);
  return writeMultiturnArtifacts(context, payloadBuild);
}
