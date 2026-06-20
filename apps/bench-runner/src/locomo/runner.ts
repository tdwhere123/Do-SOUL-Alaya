import { writeLocomoRunArchive } from "./runner-archive.js";
import { prepareLocomoRun } from "./runner-context.js";
import {
  buildLocomoPayload,
  logLocomoSeedExtractionStats
} from "./runner-payload.js";
import type { LocomoRunOptions, LocomoRunResult } from "./runner-types.js";
import { runLocomoConversationWindow } from "./runner-window.js";

export type { LocomoRunOptions, LocomoRunResult } from "./runner-types.js";
export {
  buildLocomoSeedContent,
  resolveLocomoQaQuestionType,
  resolveLocomoSampleSize
} from "./runner-utils.js";

export async function runLocomo(
  opts: LocomoRunOptions
): Promise<LocomoRunResult> {
  const context = await prepareLocomoRun(opts);
  const aggregate = await runLocomoConversationWindow({
    window: context.window,
    opts,
    embeddingMode: context.embeddingMode,
    seedRunner: context.seedRunner
  });
  const extractionStats = context.seedRunner.stats;
  logLocomoSeedExtractionStats(extractionStats);
  const { payload, diagnosticsPayload } = buildLocomoPayload({
    opts,
    conversations: context.conversations,
    aggregate,
    runAt: context.runAt,
    alayaVersion: context.alayaVersion,
    commitSha7: context.commitSha7,
    embeddingProvider: context.embeddingProvider,
    embeddingMode: context.embeddingMode,
    extractionStats
  });
  return await writeLocomoRunArchive({
    opts,
    runAt: context.runAt,
    commitSha7: context.commitSha7,
    payload,
    diagnosticsPayload
  });
}
