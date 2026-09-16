export {
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  isCjkSegmentationCandidate,
  readCjkSegmentationStatus,
  segmentCjkRun,
  warmCjkSegmentation
} from "./cjk-segmentation.js";
export type { CjkSegmentationStatus } from "./cjk-segmentation.js";
