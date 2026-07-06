import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import type { BenchRecallWeightOverrides } from "../harness/recall-weight-overrides.js";
import {
  aggregateLongMemEvalRunResults,
  logLongMemEvalExtractionStats
} from "./runner-archive-aggregate.js";
import { buildLongMemEvalRunPayload } from "./runner-archive-payload.js";
import { writeLongMemEvalRunArchive } from "./runner-archive-write.js";
import type { CompileSeedExtractionStats } from "./compile-seed.js";
import type { BenchCommitInfo } from "./runner-helpers.js";
import type { LongMemEvalRunOptions, LongMemEvalRunResult } from "./runner.js";
import type { LongMemEvalWorkerResult } from "./runner-question.js";

// End-to-end QA option, shape mirrors cli.ts qaOption (chat fn + model labels).
export async function finalizeLongMemEvalRun(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly questionsLength: number;
  readonly windowLength: number;
  readonly collected: readonly LongMemEvalWorkerResult[];
  readonly extractionStats: CompileSeedExtractionStats;
  readonly seedFuelInventory: import("./seed-fuel-inventory.js").SeedFuelInventory;
  readonly alayaVersion: string;
  readonly commitInfo: BenchCommitInfo;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingProviderLabel: string;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
}): Promise<LongMemEvalRunResult> {
  logLongMemEvalExtractionStats(input.extractionStats);
  const aggregate = aggregateLongMemEvalRunResults(input.collected);
  const build = buildLongMemEvalRunPayload({
    ...input,
    aggregate
  });
  return writeLongMemEvalRunArchive({
    opts: input.opts,
    aggregate,
    build,
    commitInfo: input.commitInfo,
    commitSha7: input.commitSha7,
    runAt: input.runAt,
    questionFailures: input.questionFailures,
    failedQuestionIds: input.failedQuestionIds,
    collectedLength: input.collected.length
  });
}
