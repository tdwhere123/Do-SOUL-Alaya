import {
  bindCjkRunSegmenter,
  fallbackCjkRunPieces,
  isCjkSegmentationCandidate,
  readErrorMessage
} from "@do-soul/alaya-protocol";

export { isCjkSegmentationCandidate };

/**
 * CJK-aware lazy word segmenter backed by @node-rs/jieba.
 *
 * `segmentCjkRun(text)` returns word-level pieces for a string containing
 * Han / Hiragana / Katakana characters; for other scripts (Hangul, Arabic,
 * Latin, …) jieba degenerates to per-codepoint splits, so callers should
 * route only Han/Hiragana/Katakana-bearing runs through here and leave the
 * remaining scripts on the existing Unicode regex path.
 *
 * Fail-soft contract: if the @node-rs/jieba native binding cannot load on
 * this host (missing platform binary, jieba ESM import error, dict read
 * error, …) the segmenter emits a structured process warning and splits
 * only the interrogative atoms owned by protocol so WH-final/medial
 * queries still tokenize. Other CJK runs stay a single surface piece.
 * Recall paths therefore never throw on a missing jieba.
 *
 * Lifecycle: the jieba instance + dict are loaded exactly once on the
 * first successful `segmentCjkRun` call, then cached for the process. A
 * load failure is also cached so subsequent calls fall through to the
 * trivial split without re-paying the import cost.
 */

type CjkSegmenter = { cut(input: string): readonly string[] };
type CjkSegmenterLoader = () => Promise<CjkSegmenter | null>;
export type CjkSegmentationStatus = "uninitialized" | "loading" | "ready" | "unavailable";

export const CJK_SEGMENTATION_FALLBACK_WARNING_CODE = "ALAYA_CJK_SEGMENTATION_FALLBACK";
const CJK_SEGMENTATION_FALLBACK_WARNING_MESSAGE =
  "[CjkSegmentation] @node-rs/jieba unavailable; using surface-token fallback";
const CJK_SEGMENTATION_COLD_FALLBACK_WARNING_CODE = "ALAYA_CJK_SEGMENTATION_COLD_FALLBACK";
const CJK_SEGMENTATION_COLD_FALLBACK_WARNING_MESSAGE =
  "[CjkSegmentation] @node-rs/jieba not ready; using surface-token fallback for this call";

let jiebaState:
  | { readonly kind: "uninitialized" }
  | { readonly kind: "loading"; readonly promise: Promise<CjkSegmenter | null> }
  | { readonly kind: "ready"; readonly cut: (input: string) => readonly string[] }
  | { readonly kind: "unavailable" } = { kind: "uninitialized" };
let loadJiebaOverrideForTests: CjkSegmenterLoader | null = null;
let emittedColdFallbackWarning = false;

async function loadJieba(): Promise<CjkSegmenter | null> {
  try {
    if (loadJiebaOverrideForTests !== null) {
      return await loadJiebaOverrideForTests();
    }
    const jieba = await import("@node-rs/jieba");
    const dictMod = await import("@node-rs/jieba/dict.js");
    const instance = jieba.Jieba.withDict(dictMod.dict);
    return {
      cut: (input: string) => instance.cut(input)
    };
  } catch (error) {
    emitCjkSegmentationFallbackWarning(error);
    return null;
  }
}

function emitCjkSegmentationFallbackWarning(error: unknown): void {
  process.emitWarning(CJK_SEGMENTATION_FALLBACK_WARNING_MESSAGE, {
    code: CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
    detail: JSON.stringify({
      layer: "cjk-segmentation",
      error: readErrorMessage(error, "Unknown jieba load failure")
    })
  });
}

function emitCjkSegmentationColdFallbackWarning(): void {
  if (emittedColdFallbackWarning) {
    return;
  }
  emittedColdFallbackWarning = true;
  process.emitWarning(CJK_SEGMENTATION_COLD_FALLBACK_WARNING_MESSAGE, {
    code: CJK_SEGMENTATION_COLD_FALLBACK_WARNING_CODE,
    detail: JSON.stringify({
      layer: "cjk-segmentation",
      state: jiebaState.kind
    })
  });
}

async function ensureSegmenter(): Promise<CjkSegmenter | null> {
  if (jiebaState.kind === "ready") {
    return { cut: jiebaState.cut };
  }
  if (jiebaState.kind === "unavailable") {
    return null;
  }
  if (jiebaState.kind === "loading") {
    return jiebaState.promise;
  }
  const promise = loadJieba().then((result) => {
    if (result === null) {
      jiebaState = { kind: "unavailable" };
      return null;
    }
    jiebaState = { kind: "ready", cut: result.cut };
    return result;
  });
  jiebaState = { kind: "loading", promise };
  return promise;
}

/** Optional warm-up so the first user query does not pay the native import cost. */
export async function warmCjkSegmentation(): Promise<boolean> {
  const segmenter = await ensureSegmenter();
  return segmenter !== null;
}

export function readCjkSegmentationStatus(): CjkSegmentationStatus {
  return jiebaState.kind;
}

/**
 * Synchronously segment a CJK-bearing run into word-level pieces. Warm
 * jieba returns cut pieces. The cold path is an atom-split fallback via
 * protocol interrogative atoms; other CJK stays one surface piece so
 * sync tokenizers never block or invent a full lexicon.
 */
export function segmentCjkRun(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  if (jiebaState.kind === "ready") {
    const pieces = jiebaState.cut(text)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
    return pieces.length === 0 ? [text] : pieces;
  }
  if (jiebaState.kind === "uninitialized") {
    void ensureSegmenter();
  }
  if (jiebaState.kind !== "unavailable") {
    emitCjkSegmentationColdFallbackWarning();
  }
  return fallbackCjkRunPieces(text);
}

/** Internal-only: reset cached jieba state between test scenarios. */
export function __resetCjkSegmentationStateForTests(): void {
  jiebaState = { kind: "uninitialized" };
  loadJiebaOverrideForTests = null;
  emittedColdFallbackWarning = false;
}

export function __setCjkSegmentationLoaderForTests(loader: CjkSegmenterLoader): void {
  loadJiebaOverrideForTests = loader;
  jiebaState = { kind: "uninitialized" };
  emittedColdFallbackWarning = false;
}

bindCjkRunSegmenter(segmentCjkRun);

