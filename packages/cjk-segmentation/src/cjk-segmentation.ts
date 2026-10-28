import {
  AlayaError, projectSegmentedFtsSource, tokenizeFtsQuery,
  fallbackCjkRunPieces,
  isCjkSegmentationCandidate,
  readErrorMessage
} from "@do-soul/alaya-protocol";
import { bindCjkRunSegmenter } from "@do-soul/alaya-protocol/node/source-frame";

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
let sourceIndexAnalysisFailed = false;

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
 * sync tokenizers never block or invent a full lexicon. Snapshot-bound readers
 * can set initialize=false to reuse warm segmentation without starting native loading.
 */
export function segmentCjkRun(text: string, options: Readonly<{ initialize?: boolean }> = {}): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  if (jiebaState.kind === "ready") {
    const pieces = jiebaState.cut(text)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
    return pieces.length === 0 ? [text] : pieces;
  }
  if (options.initialize !== false) {
    if (jiebaState.kind === "uninitialized") void ensureSegmenter();
    if (jiebaState.kind !== "unavailable") emitCjkSegmentationColdFallbackWarning();
  }
  return fallbackCjkRunPieces(text);
}

/** Strict analyzer failure does not redefine the unrelated legacy fail-soft segmenter. */
export function readSourceIndexLexicalAnalysisStatus(): CjkSegmentationStatus {
  return sourceIndexAnalysisFailed ? "unavailable" : jiebaState.kind;
}

/** Strict SourceIndex variant: never initializes or falls back inside a read snapshot. */
export const SOURCE_INDEX_SEGMENTED_UNIT_BYTES = 64;

export function analyzeSourceIndexLexical(text: string, purpose: "source", version?: "v1" | "v2"): string;
export function analyzeSourceIndexLexical(text: string, purpose: "query", version?: "v1" | "v2"): readonly string[];
export function analyzeSourceIndexLexical(text: string, purpose: "source" | "query", version: "v1" | "v2" = "v1"): string | readonly string[] {
  if (jiebaState.kind !== "ready" || sourceIndexAnalysisFailed) {
    throw new AlayaError("SOURCE_INDEX_FAILED", `segmenter_${readSourceIndexLexicalAnalysisStatus()}`);
  }
  const cut = jiebaState.cut;
  const segment = (token: string): readonly string[] => {
    const pieces = cut(token);
    if (pieces.length === 0 || pieces.some(piece => typeof piece !== "string" || piece.trim().length === 0)) {
      throw new AlayaError("SOURCE_INDEX_FAILED", "segmenter_invalid_output");
    }
    if (version === "v2" && pieces.join("") !== token) {
      throw new AlayaError("SOURCE_INDEX_FAILED", "segmenter_nonconserving_output");
    }
    return pieces;
  };
  try {
    return purpose === "source" ? projectSegmentedFtsSource(text, isCjkSegmentationCandidate, segment)
      : tokenizeFtsQuery(text, { shouldSegmentToken: isCjkSegmentationCandidate,
        segmentToken: version === "v1" ? segment : token => segmentBoundedToken(token, segment) });
  } catch (error) {
    sourceIndexAnalysisFailed = true;
    throw error;
  }
}

function segmentBoundedToken(token: string, segment: (token: string) => readonly string[]): readonly string[] {
  const pieces: string[] = [];
  let unit = "", bytes = 0;
  for (const character of token) {
    const size = Buffer.byteLength(character);
    if (bytes + size > SOURCE_INDEX_SEGMENTED_UNIT_BYTES) {
      pieces.push(...segmentSourceUnit(unit, segment)); unit = ""; bytes = 0;
    }
    unit += character; bytes += size;
  }
  if (unit.length > 0) pieces.push(...segmentSourceUnit(unit, segment));
  return pieces;
}

function segmentSourceUnit(unit: string, segment: (token: string) => readonly string[]): readonly string[] {
  return isCjkSegmentationCandidate(unit) ? segment(unit) : [unit];
}

/** The pending surface unit is at most 64 UTF-8 bytes and continues across source reads. */
export function advanceSourceIndexLexicalV2(text: string, pending: string, final: boolean, onWork?: (units: number) => void): {
  projection: string; pending: string; expanded_units: number;
} {
  const projections: string[] = [];
  let unit = pending, bytes = Buffer.byteLength(unit), expanded = 0;
  const flush = () => {
    if (unit.length === 0) return;
    expanded += unit.length;
    onWork?.(unit.length);
    const projection = analyzeSourceIndexLexical(unit, "source", "v2");
    onWork?.(projection.length);
    projections.push(projection);
    unit = ""; bytes = 0;
  };
  for (const character of text) {
    if (!/[\p{L}\p{N}_]/u.test(character)) { flush(); continue; }
    const size = Buffer.byteLength(character);
    if (bytes + size > SOURCE_INDEX_SEGMENTED_UNIT_BYTES) flush();
    unit += character; bytes += size;
  }
  if (final) flush();
  return { projection: projections.join(" "), pending: unit, expanded_units: expanded };
}

/** Internal-only: reset cached jieba state between test scenarios. */
export function __resetCjkSegmentationStateForTests(): void {
  jiebaState = { kind: "uninitialized" };
  loadJiebaOverrideForTests = null;
  emittedColdFallbackWarning = false;
  sourceIndexAnalysisFailed = false;
}

export function __setCjkSegmentationLoaderForTests(loader: CjkSegmenterLoader): void {
  loadJiebaOverrideForTests = loader;
  sourceIndexAnalysisFailed = false;
  jiebaState = { kind: "uninitialized" };
  emittedColdFallbackWarning = false;
}

bindCjkRunSegmenter(segmentCjkRun);

