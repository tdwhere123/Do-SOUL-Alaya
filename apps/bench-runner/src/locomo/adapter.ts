import {
  logSeedExtractionStats,
  type BenchCampaignAdapter
} from "../bench/index.js";
import { loadLocomo } from "./fetch.js";
import { buildLocomoPayload } from "./runner-payload.js";
import type { LocomoRunOptions } from "./runner-types.js";
import { collectDistinctLocomoTurnContents } from "./runner-utils.js";
import {
  runLocomoConversationWindow,
  type LocomoConversationAggregate
} from "./runner-window.js";
import type { LocomoSample } from "./dataset.js";

export const locomoCampaignAdapter: BenchCampaignAdapter<
  LocomoRunOptions,
  LocomoSample,
  LocomoConversationAggregate
> = {
  identity: {
    benchName: "public-locomo",
    split: "locomo10",
    diagnosticsFilename: "locomo-diagnostics.json",
    baselinePointerKind: "passing"
  },
  loadDataset(opts) {
    return loadLocomo(opts.variant, {
      dataDir: opts.dataDir,
      pinnedMetaRoot: opts.pinnedMetaRoot
    });
  },
  collectRequiredTurnContents: collectDistinctLocomoTurnContents,
  runWindow: runLocomoConversationWindow,
  buildPayload(input) {
    return buildLocomoPayload({
      opts: input.opts,
      conversations: input.dataset,
      aggregate: input.aggregate,
      runAt: input.runAt,
      alayaVersion: input.alayaVersion,
      commitSha7: input.commitSha7,
      embeddingProvider: input.embeddingProvider,
      embeddingMode: input.embeddingMode,
      extractionStats: input.extractionStats
    });
  },
  logExtractionStats(stats) {
    logSeedExtractionStats("locomo", stats);
  }
};
