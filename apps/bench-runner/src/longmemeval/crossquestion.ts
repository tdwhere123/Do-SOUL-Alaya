import type {
  KpiPayload,
  VerifiedLongMemEvalEvidenceContext
} from "@do-soul/alaya-eval";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall/recall-diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from "./diagnostics.js";
import type { LongMemEvalVariant } from "./ingestion/dataset.js";
import type { FetchResult } from "./ingestion/fetch.js";
import {
  buildCrossQuestionPayload,
  writeCrossQuestionArtifacts
} from "./crossquestion/crossquestion-payload.js";
import {
  executeCrossQuestionRun,
  prepareCrossQuestionRun
} from "./crossquestion/crossquestion-run.js";

export interface LongMemEvalCrossQuestionRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
  readonly extractionCacheRoot?: string;
}

export interface LongMemEvalCrossQuestionRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
  readonly evidenceContext: VerifiedLongMemEvalEvidenceContext | null;
}

export interface SidecarEntry {
  readonly questionId: string;
  readonly sessionId: string;
  readonly hasAnswer: boolean;
}

export interface QuestionResult {
  readonly questionId: string;
  readonly questionIndex: number;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly seedTurnsTruncated: number;
  readonly answerTurnsTruncated: number;
  readonly seedCharsClipped: number;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
}

export async function runLongMemEvalCrossQuestion(
  opts: LongMemEvalCrossQuestionRunOptions
): Promise<LongMemEvalCrossQuestionRunResult> {
  const context = await prepareCrossQuestionRun(opts);
  const execution = await executeCrossQuestionRun(context);
  const payloadBuild = buildCrossQuestionPayload(context, execution);
  return writeCrossQuestionArtifacts(context, payloadBuild);
}
