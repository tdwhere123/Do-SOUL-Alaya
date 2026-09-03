import { AsyncLocalStorage } from "node:async_hooks";

export interface RecallLiveExtractionAccounting {
  readonly providerExecutorEntries: number;
  readonly extractionWrites: number;
}

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
  return recallZeroLiveCampaign.run(campaign, async () => {
    const result = await run();
    assertRecallZeroLiveExtraction(campaign);
    return result;
  });
}

export function refuseRecallCampaignLiveExtraction(
  kind: "provider_executor" | "extraction_write" = "provider_executor"
): void {
  const campaign = recallZeroLiveCampaign.getStore();
  if (campaign === undefined) return;
  if (kind === "extraction_write") campaign.extractionWrites += 1;
  else campaign.providerExecutorEntries += 1;
  throw new Error("recall campaign attempted live extraction");
}

export function assertRecallZeroLiveExtraction(
  input?: RecallLiveExtractionAccounting
): void {
  const counts = input ?? recallZeroLiveCampaign.getStore() ?? {
    providerExecutorEntries: 0,
    extractionWrites: 0
  };
  if (counts.providerExecutorEntries !== 0 || counts.extractionWrites !== 0) {
    throw new Error("recall campaign attempted live extraction");
  }
}
