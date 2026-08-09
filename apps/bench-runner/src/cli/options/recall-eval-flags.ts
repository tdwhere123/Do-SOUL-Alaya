import type { ParsedFlagsState } from "../cli-options.js";
import {
  matchFlagToken,
  nextIndex,
  readRequiredFlagValue
} from "./flag-values.js";

export function consumeRecallEvalPathFlag(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number | undefined {
  if (matchFlagToken(token, "--query-semantic-factor-cache")) {
    state.querySemanticFactorCache = readRequiredFlagValue(
      args, index, token, "--query-semantic-factor-cache",
      "--query-semantic-factor-cache requires a JSON cache path"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--warm-derived-snapshot-receipt")) {
    state.warmDerivedSnapshotReceipt = readRequiredFlagValue(
      args, index, token, "--warm-derived-snapshot-receipt",
      "--warm-derived-snapshot-receipt requires a JSON receipt path"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--fact-frame-retrofit-ledger")) {
    state.factFrameRetrofitLedger = readRequiredFlagValue(
      args, index, token, "--fact-frame-retrofit-ledger",
      "--fact-frame-retrofit-ledger requires an NDJSON path"
    );
    return nextIndex(index, token);
  }
  if (!matchFlagToken(token, "--seed-extraction-system-prompt")) {
    return undefined;
  }
  state.seedExtractionSystemPrompt = readRequiredFlagValue(
    args, index, token, "--seed-extraction-system-prompt",
    "--seed-extraction-system-prompt requires a text path"
  );
  return nextIndex(index, token);
}
