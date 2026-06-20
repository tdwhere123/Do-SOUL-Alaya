import {
  BENCH_FULL_TURN_CONTENT_KEY,
  BENCH_SEED_MARKER_KEY,
  BENCH_STORED_CONTENT_KEY,
  BENCH_TURN_SEED_INDEX_KEY
} from "./token-economy.js";

export const SEED_CONTENT_MAX = 15_000;

export function clipSeedContent(content: string): {
  readonly safe: string;
  readonly truncated: boolean;
  readonly charsClipped: number;
} {
  if (content.length <= SEED_CONTENT_MAX) {
    return { safe: content, truncated: false, charsClipped: 0 };
  }
  return {
    safe: `${content.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`,
    truncated: true,
    charsClipped: content.length - SEED_CONTENT_MAX
  };
}

export function benchTokenEconomyPayload(input: {
  readonly fullTurnContent: string;
  readonly storedContent: string;
  readonly turnSeedIndex?: number;
  readonly excerptSibling?: string;
  readonly distilledFactSibling?: string;
}): Record<string, unknown> {
  const storedDuplicatesSibling =
    input.storedContent === input.distilledFactSibling ||
    (input.distilledFactSibling === undefined &&
      input.storedContent === input.excerptSibling);
  return {
    [BENCH_SEED_MARKER_KEY]: true,
    ...(input.fullTurnContent === input.excerptSibling
      ? {}
      : { [BENCH_FULL_TURN_CONTENT_KEY]: input.fullTurnContent }),
    ...(storedDuplicatesSibling
      ? {}
      : { [BENCH_STORED_CONTENT_KEY]: input.storedContent }),
    ...(input.turnSeedIndex === undefined
      ? {}
      : { [BENCH_TURN_SEED_INDEX_KEY]: input.turnSeedIndex })
  };
}

export function buildSourceMemoryRefsField(
  refs: readonly string[] | undefined
): Record<string, unknown> {
  if (refs === undefined || refs.length === 0) {
    return {};
  }
  const unique = [...new Set(refs.filter((ref) => typeof ref === "string" && ref.length > 0))];
  if (unique.length === 0) {
    return {};
  }
  return { source_memory_refs: unique };
}

const FIRST_CLASS_MEMORY_REF_KEYS = [
  "source_memory_refs",
  "supersedes_refs",
  "exception_to_refs",
  "contradicts_refs",
  "incompatible_with_refs"
] as const;

export function stripFirstClassMemoryRefsFromRawPayload(
  rawPayload: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const sanitized = { ...rawPayload };
  for (const key of FIRST_CLASS_MEMORY_REF_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}
