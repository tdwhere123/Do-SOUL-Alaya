import { warmCjkSegmentation } from "@do-soul/alaya-protocol";

export async function awaitCjkSegmentationWarmup(warnLogger: {
  warn(message: string, meta: Record<string, unknown>): void;
}): Promise<void> {
  try {
    const ready = await warmCjkSegmentation();
    if (ready) {
      return;
    }
    warnLogger.warn("CJK segmentation warmup unavailable; recall will use surface-only fallback until lazy load succeeds", {
      code: "ALAYA_CJK_SEGMENTATION_WARMUP_FAILED",
      ready
    });
  } catch (error: unknown) {
    warnLogger.warn("CJK segmentation warmup failed; recall will use surface-only fallback until lazy load succeeds", {
      code: "ALAYA_CJK_SEGMENTATION_WARMUP_FAILED",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function startCjkSegmentationWarmup(warnLogger: {
  warn(message: string, meta: Record<string, unknown>): void;
}): void {
  void awaitCjkSegmentationWarmup(warnLogger);
}
