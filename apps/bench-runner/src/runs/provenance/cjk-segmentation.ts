import {
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE as CORE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  readCjkSegmentationStatus as readCoreCjkSegmentationStatus
} from "@do-soul/alaya-core";
import {
  readCjkSegmentationStatus as readStorageCjkSegmentationStatus,
  STORAGE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE
} from "@do-soul/alaya-storage";

export function collectCjkSegmentationProvenance(): {
  core_status: ReturnType<typeof readCoreCjkSegmentationStatus>;
  storage_status: ReturnType<typeof readStorageCjkSegmentationStatus>;
  warnings: string[];
} {
  const core_status = readCoreCjkSegmentationStatus();
  const storage_status = readStorageCjkSegmentationStatus();
  return {
    core_status,
    storage_status,
    warnings: [
      ...(core_status === "unavailable" ? [CORE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE] : []),
      ...(storage_status === "unavailable" ? [STORAGE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE] : [])
    ]
  };
}
