import type { ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import type { LongMemEvalVariant } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { censusNativeSourceRecords, type SourceCensusRecord } from "../../snapshot/source-records/census.js";
import { nativeSourceRequestInventory } from "./source-request-workset.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";

export type ExtractionFillVariant = LongMemEvalVariant | "native_source_snapshot";
import { loadDatasetWithIdentity } from "../../../datasets/longmemeval/ingestion/fetch.js";
import type { PreparedExpansionFillAuthority } from "../expansion-fill-authority.js";
import {
  inspectTurnContentKeySpace,
  type LongMemEvalExtractionTurn
} from "../turn-contents.js";

interface ExtractionFillWindowOptions {
  readonly openSemantics?: boolean;
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly variant: ExtractionFillVariant;
  readonly nativeSourcePopulation?: Readonly<{ name: string; snapshotPath: string }>;
  readonly config?: CompileSeedExtractionConfig;
  readonly limit?: number;
  readonly offset?: number;
  readonly questionBatchLimit?: number;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
}

interface ExtractionFillWindow {
  readonly distinctTurns: readonly string[];
  readonly executionTurns: readonly string[];
  readonly distinctExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly executionExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly occurrenceExtractionTurns?: readonly LongMemEvalExtractionTurn[];
  readonly nativeSourceRecords?: readonly SourceCensusRecord[];
  readonly requestedTurns: number;
  readonly executionRequestedTurns: number;
  readonly windowUniqueCacheKeys: number;
  readonly windowTurnOccurrences: number;
  readonly unsupportedSourceOccurrences: number;
  readonly executionTurnOccurrences: number;
  readonly questionCount: number;
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly questionBatchLimit?: number;
}

export async function prepareExtractionFillWindow(
  options: ExtractionFillWindowOptions,
  expansion: PreparedExpansionFillAuthority | undefined
): Promise<ExtractionFillWindow> {
  if (expansion !== undefined) {
    if (options.nativeSourcePopulation !== undefined) throw new Error("native source population cannot mix expansion");
    return prepareExpansionWindow(options, expansion);
  }
  if (options.variant === "native_source_snapshot") {
    return prepareNativeWindow(options);
  }
  if (options.nativeSourcePopulation !== undefined) throw new Error("native source population requires its own variant");
  return await prepareDatasetWindow(options);
}

function prepareNativeWindow(options: ExtractionFillWindowOptions): ExtractionFillWindow {
  if (options.nativeSourcePopulation === undefined || options.config === undefined ||
      options.sourcePacking !== "complete-source" || !options.openSemantics ||
      options.offset !== undefined || options.limit !== undefined || options.questionBatchLimit !== undefined) {
    throw new Error("native source window requires one complete verified snapshot and semantic generation");
  }
  const census = censusNativeSourceRecords({ population: options.nativeSourcePopulation.name,
    snapshotPath: options.nativeSourcePopulation.snapshotPath });
  const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, options.config);
  // The legacy window counters here count native source occurrences, not dialogue turns/questions.
  return { distinctTurns: [], executionTurns: [], distinctExtractionTurns: [], executionExtractionTurns: [],
    nativeSourceRecords: census.records, requestedTurns: inventory.requests.length,
    executionRequestedTurns: inventory.requests.length, windowUniqueCacheKeys: inventory.requests.length,
    windowTurnOccurrences: census.records.length, unsupportedSourceOccurrences: inventory.unsupportedSources.length,
    executionTurnOccurrences: census.records.length, questionCount: census.records.length,
    datasetRevision: census.dataset_sha256, windowOffset: 0 };
}

function prepareExpansionWindow(
  options: ExtractionFillWindowOptions,
  expansion: PreparedExpansionFillAuthority
): ExtractionFillWindow {
  if (options.questionBatchLimit !== undefined) {
    throw new Error("question-bounded extraction cannot mix an expansion capability");
  }
  const keySpace = inspectTurnContentKeySpace(expansion.nextQuestions, options.sourcePacking, options.openSemantics);
  assertSameTurnWindow(keySpace.distinctExtractionTurns, expansion.nextTurns);
  const turnContents = expansion.nextTurns.map(({ turnContent }) => turnContent);
  return {
    distinctTurns: turnContents,
    executionTurns: turnContents,
    distinctExtractionTurns: expansion.nextTurns,
    executionExtractionTurns: expansion.nextTurns,
    occurrenceExtractionTurns: keySpace.occurrenceExtractionTurns,
    requestedTurns: keySpace.distinctExtractionRequestCount,
    executionRequestedTurns: keySpace.distinctExtractionRequestCount,
    windowUniqueCacheKeys: keySpace.distinctExtractionRequestCount,
    windowTurnOccurrences: expansion.nextTurns.length,
    unsupportedSourceOccurrences: keySpace.unsupportedSourceOccurrences,
    executionTurnOccurrences: expansion.nextTurns.length,
    questionCount: expansion.nextQuestions.length,
    datasetRevision: expansion.datasetRevision,
    windowOffset: 0
  };
}

async function prepareDatasetWindow(
  options: ExtractionFillWindowOptions
): Promise<ExtractionFillWindow> {
  if (options.variant === "native_source_snapshot") throw new Error("native source snapshot requires native preparation");
  const dataset = await loadDatasetWithIdentity(options.variant, {
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  const offset = Math.max(0, options.offset ?? 0);
  const sliceEnd = options.limit === undefined
    ? dataset.questions.length
    : offset + options.limit;
  const questions = dataset.questions.slice(offset, sliceEnd);
  const batchLimit = resolveQuestionBatchLimit(options.questionBatchLimit, questions.length);
  const windowKeySpace = inspectTurnContentKeySpace(questions, options.sourcePacking, options.openSemantics);
  const executionKeySpace = batchLimit === questions.length
    ? windowKeySpace
    : inspectTurnContentKeySpace(questions.slice(0, batchLimit), options.sourcePacking, options.openSemantics);
  const distinctTurns = windowKeySpace.distinctTurnContents;
  const executionTurns = executionKeySpace.distinctTurnContents;
  return {
    distinctTurns,
    executionTurns,
    distinctExtractionTurns: windowKeySpace.distinctExtractionTurns,
    executionExtractionTurns: executionKeySpace.distinctExtractionTurns,
    occurrenceExtractionTurns: windowKeySpace.occurrenceExtractionTurns,
    requestedTurns: windowKeySpace.distinctExtractionRequestCount,
    executionRequestedTurns: executionKeySpace.distinctExtractionRequestCount,
    windowUniqueCacheKeys: windowKeySpace.distinctExtractionRequestCount,
    windowTurnOccurrences: windowKeySpace.turnOccurrences,
    unsupportedSourceOccurrences: windowKeySpace.unsupportedSourceOccurrences,
    executionTurnOccurrences: executionKeySpace.turnOccurrences,
    questionCount: questions.length,
    datasetRevision: dataset.sha256,
    windowOffset: offset,
    ...(options.questionBatchLimit === undefined ? {} : {
      questionBatchLimit: options.questionBatchLimit
    })
  };
}

function assertSameTurnWindow(
  actual: readonly LongMemEvalExtractionTurn[],
  expected: readonly LongMemEvalExtractionTurn[]
): void {
  if (actual.length === expected.length && actual.every((turn, index) =>
    sameExtractionTurn(turn, expected[index])
  )) {
    return;
  }
  throw new Error("expansion extraction turns disagree with the trusted message window");
}

function sameExtractionTurn(
  left: LongMemEvalExtractionTurn,
  right: LongMemEvalExtractionTurn | undefined
): boolean {
  return right !== undefined && left.turnContent === right.turnContent &&
    left.turnMessages.length === right.turnMessages.length &&
    left.turnMessages.every((message, index) =>
      message.role === right.turnMessages[index]?.role &&
      message.content === right.turnMessages[index]?.content
    );
}

function resolveQuestionBatchLimit(raw: number | undefined, questionCount: number): number {
  if (raw === undefined) return questionCount;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > questionCount) {
    throw new Error(`question batch limit must be within the ${questionCount}-question window`);
  }
  return raw;
}
