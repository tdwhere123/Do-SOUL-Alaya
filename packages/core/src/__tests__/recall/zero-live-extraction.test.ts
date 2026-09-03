import { describe, expect, it } from "vitest";
import {
  assertRecallZeroLiveExtraction,
  refuseRecallCampaignLiveExtraction,
  withRecallZeroLiveCampaign
} from "../../recall/runtime/zero-live-extraction.js";

describe("recall zero-live extraction", () => {
  it("allows a campaign that never enters fill or a provider executor", async () => {
    await expect(withRecallZeroLiveCampaign(async () => {
      assertRecallZeroLiveExtraction();
      return "ok";
    })).resolves.toBe("ok");
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 0, extractionWrites: 0
    })).not.toThrow();
  });

  it("fails closed when a campaign enters the fill path", async () => {
    await expect(withRecallZeroLiveCampaign(async () => {
      refuseRecallCampaignLiveExtraction("extraction_write");
    })).rejects.toThrow(/live extraction/u);
  });

  it("fails closed when a campaign enters a provider executor", async () => {
    await expect(withRecallZeroLiveCampaign(async () => {
      refuseRecallCampaignLiveExtraction("provider_executor");
    })).rejects.toThrow(/live extraction/u);
  });

  it("does not refuse fill outside a recall campaign", () => {
    expect(() => refuseRecallCampaignLiveExtraction("extraction_write")).not.toThrow();
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 1, extractionWrites: 0
    })).toThrow(/live extraction/u);
  });
});
