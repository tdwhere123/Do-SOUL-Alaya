export {
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  analyzeSourceIndexLexical,
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  isCjkSegmentationCandidate,
  readCjkSegmentationStatus,
  readSourceIndexLexicalAnalysisStatus,
  segmentCjkRun,
  warmCjkSegmentation
} from "./cjk-segmentation.js";
export type { CjkSegmentationStatus } from "./cjk-segmentation.js";
