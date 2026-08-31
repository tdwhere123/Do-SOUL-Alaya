import { runBenchCampaign } from "../../runs/index.js";
import { locomoCampaignAdapter } from "./adapter.js";
import type { LocomoRunOptions, LocomoRunResult } from "./runner-types.js";

export type { LocomoRunOptions, LocomoRunResult } from "./runner-types.js";
export {
  buildLocomoSeedContent,
  resolveLocomoQaQuestionType,
  resolveLocomoSampleSize
} from "./runner-utils.js";

export async function runLocomo(
  opts: LocomoRunOptions
): Promise<LocomoRunResult> {
  return runBenchCampaign(locomoCampaignAdapter, opts);
}
