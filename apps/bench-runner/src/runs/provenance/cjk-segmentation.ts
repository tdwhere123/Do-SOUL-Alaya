import {
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  readCjkSegmentationStatus
} from "@do-soul/alaya-protocol";

export function collectCjkSegmentationProvenance(): {
  core_status: ReturnType<typeof readCjkSegmentationStatus>;
  storage_status: ReturnType<typeof readCjkSegmentationStatus>;
  warnings: string[];
} {
  const status = readCjkSegmentationStatus();
  return {
    core_status: status,
    storage_status: status,
    warnings: status === "unavailable" ? [CJK_SEGMENTATION_FALLBACK_WARNING_CODE] : []
  };
}
