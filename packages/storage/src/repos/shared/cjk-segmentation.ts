/**
 * CJK-aware lazy word segmenter for storage-side FTS query tokenization.
 *
 * Storage and core both run jieba locally rather than sharing one module:
 * the Package Dependency Direction forbids storage importing from core
 * (`docs/handbook/invariants.md` §1-§4). Each layer owns its own jieba
 * symlink; the surface here is intentionally minimal so the two copies
 * can diverge if storage ever needs an FTS-specific segmenter knob.
 *
 * Fail-soft: if @node-rs/jieba cannot load on this host, the helper
 * returns the input as a single element so `tokenizeFtsQuery` callers
 * never throw. see also: packages/core/src/shared/cjk-segmentation.ts.
 */

let jiebaState:
  | { readonly kind: "uninitialized" }
  | { readonly kind: "loading"; readonly promise: Promise<{ cut(input: string): readonly string[] } | null> }
  | { readonly kind: "ready"; readonly cut: (input: string) => readonly string[] }
  | { readonly kind: "unavailable" } = { kind: "uninitialized" };

// invariant: only Han/Hiragana/Katakana flow through jieba. Hangul /
// Arabic / Latin degenerate to per-codepoint splits under jieba, so
// routing them here would fragment whole words instead of helping FTS.
const CJK_WORD_SEGMENTER_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function isCjkSegmentationCandidate(token: string): boolean {
  return CJK_WORD_SEGMENTER_SCRIPTS.test(token);
}

async function loadJieba(): Promise<{ cut(input: string): readonly string[] } | null> {
  try {
    const jieba = await import("@node-rs/jieba");
    const dictMod = await import("@node-rs/jieba/dict.js");
    const instance = jieba.Jieba.withDict(dictMod.dict);
    return {
      cut: (input: string) => instance.cut(input)
    };
  } catch {
    return null;
  }
}

async function ensureSegmenter(): Promise<{ cut(input: string): readonly string[] } | null> {
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

export async function warmCjkSegmentation(): Promise<boolean> {
  const segmenter = await ensureSegmenter();
  return segmenter !== null;
}

/**
 * Synchronous CJK segmenter. Returns word-level pieces when jieba has
 * been initialized (e.g. via `warmCjkSegmentation`); otherwise yields
 * the input as a single element so the sync FTS tokenizer never blocks.
 * Triggers a background load on first call so subsequent calls can
 * benefit from segmentation without paying the import cost twice.
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
  return [text];
}

/** Internal-only: test hook to swap the cached state between runs. */
export function __resetCjkSegmentationStateForTests(): void {
  jiebaState = { kind: "uninitialized" };
}
