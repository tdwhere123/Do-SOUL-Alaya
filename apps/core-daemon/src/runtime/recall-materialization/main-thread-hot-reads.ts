import type { RecallServiceMemoryRepoPort } from "@do-soul/alaya-core";

export function bindMainThreadHotReads(
  workerRepo: RecallServiceMemoryRepoPort,
  mainRepo: Pick<
    RecallServiceMemoryRepoPort,
    "findRecallTierWindow" | "findRecallActivationTopK"
  >
): RecallServiceMemoryRepoPort {
  return {
    ...workerRepo,
    ...(mainRepo.findRecallTierWindow === undefined
      ? {}
      : { findRecallTierWindow: mainRepo.findRecallTierWindow.bind(mainRepo) }),
    ...(mainRepo.findRecallActivationTopK === undefined
      ? {}
      : { findRecallActivationTopK: mainRepo.findRecallActivationTopK.bind(mainRepo) })
  };
}
