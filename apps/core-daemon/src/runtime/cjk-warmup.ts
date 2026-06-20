import {
  warmCjkSegmentation
} from "@do-soul/alaya-core";
import { warmCjkSegmentation as warmStorageCjkSegmentation } from "@do-soul/alaya-storage";

export function startCjkSegmentationWarmup(warnLogger: { warn(message: string, meta: Record<string, unknown>): void }): void {
  void Promise.all([
    warmCjkSegmentation(),
    warmStorageCjkSegmentation()
  ])
    .then(([coreReady, storageReady]) => {
      if (coreReady && storageReady) {
        return;
      }

      warnLogger.warn("CJK segmentation warmup unavailable; recall will use surface-only fallback until lazy load succeeds", {
        code: "ALAYA_CJK_SEGMENTATION_WARMUP_FAILED",
        core_ready: coreReady,
        storage_ready: storageReady
      });
    })
    .catch((error: unknown) => {
      warnLogger.warn("CJK segmentation warmup failed; recall will use surface-only fallback until lazy load succeeds", {
        code: "ALAYA_CJK_SEGMENTATION_WARMUP_FAILED",
        error: error instanceof Error ? error.message : String(error)
      });
    });
}
