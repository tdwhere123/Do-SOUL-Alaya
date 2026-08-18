import {
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE as CORE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  readCjkSegmentationStatus as readCoreCjkSegmentationStatus
} from "@do-soul/alaya-core";
import {
  readCjkSegmentationStatus as readStorageCjkSegmentationStatus,
  STORAGE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE
} from "@do-soul/alaya-storage";

export function collectCjkSegmentationProvenance(): Readonly<{
  readonly core_status: ReturnType<typeof readCoreCjkSegmentationStatus>;
  readonly storage_status: ReturnType<typeof readStorageCjkSegmentationStatus>;
  readonly warnings: readonly string[];
}> {
  const core_status = readCoreCjkSegmentationStatus();
  const storage_status = readStorageCjkSegmentationStatus();
  const warnings = [
    ...(core_status === "unavailable" ? [CORE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE] : []),
    ...(storage_status === "unavailable" ? [STORAGE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE] : [])
  ];
  return Object.freeze({ core_status, storage_status, warnings });
}
