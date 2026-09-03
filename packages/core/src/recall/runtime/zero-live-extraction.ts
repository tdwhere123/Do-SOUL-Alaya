import { AsyncLocalStorage } from "node:async_hooks";

export interface RecallLiveExtractionAccounting {
  readonly providerExecutorEntries: number;
  readonly extractionWrites: number;
}

export const RECALL_ZERO_LIVE_CAMPAIGN_ENV = "ALAYA_RECALL_ZERO_LIVE_CAMPAIGN";
export const RECALL_ZERO_LIVE_ATTEMPTED_ENV = "ALAYA_RECALL_ZERO_LIVE_ATTEMPTED";

interface RecallZeroLiveCampaign {
  providerExecutorEntries: number;
  extractionWrites: number;
}

const recallZeroLiveCampaign = new AsyncLocalStorage<RecallZeroLiveCampaign>();

export async function withRecallZeroLiveCampaign<T>(
  run: () => Promise<T>
): Promise<T> {
  if (recallZeroLiveCampaign.getStore() !== undefined) return run();
  const campaign: RecallZeroLiveCampaign = {
    providerExecutorEntries: 0,
    extractionWrites: 0
  };
  const previousCampaign = process.env[RECALL_ZERO_LIVE_CAMPAIGN_ENV];
  const previousAttempted = process.env[RECALL_ZERO_LIVE_ATTEMPTED_ENV];
  process.env[RECALL_ZERO_LIVE_CAMPAIGN_ENV] = "1";
  delete process.env[RECALL_ZERO_LIVE_ATTEMPTED_ENV];
  try {
    return await recallZeroLiveCampaign.run(campaign, async () => {
      const result = await run();
      assertRecallZeroLiveExtraction(campaign);
      return result;
    });
  } finally {
    restoreEnv(RECALL_ZERO_LIVE_CAMPAIGN_ENV, previousCampaign);
    restoreEnv(RECALL_ZERO_LIVE_ATTEMPTED_ENV, previousAttempted);
  }
}

export function refuseRecallCampaignLiveExtraction(
  kind: "provider_executor" | "extraction_write" = "provider_executor"
): void {
  if (!recallZeroLiveCampaignActive()) return;
  const campaign = recallZeroLiveCampaign.getStore();
  if (campaign !== undefined) {
    if (kind === "extraction_write") campaign.extractionWrites += 1;
    else campaign.providerExecutorEntries += 1;
  }
  process.env[RECALL_ZERO_LIVE_ATTEMPTED_ENV] = "1";
  throw new Error("recall campaign attempted live extraction");
}

export function assertRecallZeroLiveExtraction(
  input?: RecallLiveExtractionAccounting
): void {
  if (process.env[RECALL_ZERO_LIVE_ATTEMPTED_ENV] === "1") {
    throw new Error("recall campaign attempted live extraction");
  }
  const counts = input ?? recallZeroLiveCampaign.getStore() ?? {
    providerExecutorEntries: 0,
    extractionWrites: 0
  };
  if (counts.providerExecutorEntries !== 0 || counts.extractionWrites !== 0) {
    throw new Error("recall campaign attempted live extraction");
  }
}

function recallZeroLiveCampaignActive(): boolean {
  return recallZeroLiveCampaign.getStore() !== undefined ||
    process.env[RECALL_ZERO_LIVE_CAMPAIGN_ENV] === "1";
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
