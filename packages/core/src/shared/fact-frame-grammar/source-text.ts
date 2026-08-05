export type FactFrameSourceToken = Readonly<{
  readonly text: string;
  readonly normalized: string;
  readonly start: number;
  readonly end: number;
}>;

export function tokenizeFactFrameSource(
  source: string
): readonly FactFrameSourceToken[] {
  const tokens: FactFrameSourceToken[] = [];
  for (const match of source.matchAll(FACT_FRAME_SOURCE_TOKEN_PATTERN)) {
    const start = match.index;
    const text = match[0];
    tokens.push(Object.freeze({
      text,
      normalized: text.normalize("NFKC").toLowerCase(),
      start,
      end: start + text.length
    }));
  }
  return Object.freeze(tokens);
}

export function sliceFactFrameTokens(
  source: string,
  tokens: readonly FactFrameSourceToken[],
  start: number,
  end: number
): string {
  return source.slice(tokens[start]!.start, tokens[end - 1]!.end);
}

const FACT_FRAME_SOURCE_TOKEN_PATTERN =
  /[\p{L}\p{N}@#](?:[\p{L}\p{N}_./@#-]*[\p{L}\p{N}@#])?(?:['\u2019][\p{L}\p{N}]+)?/gu;
