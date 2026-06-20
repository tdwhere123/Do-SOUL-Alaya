import { readErrorMessage } from "@do-soul/alaya-protocol";

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
 * error, …) the segmenter emits a structured process warning and returns the
 * input as a single-element array. Recall paths therefore never throw on a
 * missing jieba.
 *
 * Lifecycle: the jieba instance + dict are loaded exactly once on the
 * first successful `segmentCjkRun` call, then cached for the process. A
 * load failure is also cached so subsequent calls fall through to the
 * trivial split without re-paying the import cost.
 */

type CjkSegmenter = { cut(input: string): readonly string[] };
type CjkSegmenterLoader = () => Promise<CjkSegmenter | null>;

const CJK_SEGMENTATION_FALLBACK_WARNING_CODE = "ALAYA_CORE_CJK_SEGMENTATION_FALLBACK";
const CJK_SEGMENTATION_FALLBACK_WARNING_MESSAGE =
  "[CjkSegmentation] @node-rs/jieba unavailable; using surface-token fallback";

let jiebaState:
  | { readonly kind: "uninitialized" }
  | { readonly kind: "loading"; readonly promise: Promise<CjkSegmenter | null> }
  | { readonly kind: "ready"; readonly cut: (input: string) => readonly string[] }
  | { readonly kind: "unavailable" } = { kind: "uninitialized" };
let loadJiebaOverrideForTests: CjkSegmenterLoader | null = null;

// Han + Hiragana + Katakana are the scripts jieba actually segments at
// word level; Hangul / Arabic / other scripts fall back to per-codepoint
// splits inside jieba, so routing them through here would be a no-op
// (or worse, fragment whole words). see also: splitLexicalTokens caller.
const CJK_WORD_SEGMENTER_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function isCjkSegmentationCandidate(token: string): boolean {
  return CJK_WORD_SEGMENTER_SCRIPTS.test(token);
}

async function loadJieba(): Promise<CjkSegmenter | null> {
  try {
    if (loadJiebaOverrideForTests !== null) {
      return await loadJiebaOverrideForTests();
    }
    // Dynamic import keeps the native binding off the import graph for
    // hosts that never see CJK input. The dict subpath uses a CommonJS
    // wrapper that synchronously reads dict.txt; if either resolution
    // fails (missing platform binary, missing dict file, ESM/CJS interop
    // error), we treat segmentation as unavailable.
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
      layer: "core",
      error: readErrorMessage(error, "Unknown jieba load failure")
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

/**
 * Eagerly probe jieba availability. Optional warm-up that recall paths can
 * call once at service wire time so the first user query does not pay the
 * native binding import cost. Returns true when jieba is ready, false when
 * the host has no usable jieba (fail-soft path is in effect).
 */
export async function warmCjkSegmentation(): Promise<boolean> {
  const segmenter = await ensureSegmenter();
  return segmenter !== null;
}

/**
 * Synchronously segment a CJK-bearing run into word-level pieces. Only
 * returns segmented output when jieba has already been initialized in
 * this process (e.g. via `warmCjkSegmentation`); otherwise it returns the
 * input wrapped in a single-element array so the caller's downstream
 * tokenizer still gets the original surface form. This sync surface lets
 * sync token tokenizers like `splitLexicalTokens` (and FTS query
 * tokenizers) participate without becoming async.
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
  // Jieba not yet loaded (or unavailable). Kick off the lazy load so a
  // subsequent call can use the segmenter, but fall back to the original
  // run so callers never block the synchronous tokenization path.
  if (jiebaState.kind === "uninitialized") {
    void ensureSegmenter();
  }
  return [text];
}

/**
 * Reset the cached jieba state. Intended for tests that need to exercise
 * both the loaded-segmenter path and the fail-soft fallback path within
 * one process. Not exported from the package barrel — internal-only.
 */
export function __resetCjkSegmentationStateForTests(): void {
  jiebaState = { kind: "uninitialized" };
  loadJiebaOverrideForTests = null;
}

export function __setCjkSegmentationLoaderForTests(loader: CjkSegmenterLoader): void {
  loadJiebaOverrideForTests = loader;
  jiebaState = { kind: "uninitialized" };
}
