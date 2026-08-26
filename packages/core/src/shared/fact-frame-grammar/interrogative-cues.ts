import { AUXILIARIES, WH_WORDS } from "./clause-boundaries.js";
import { CJK_INTERROGATIVE_RESULT_FORMS } from "./cjk-interrogative-forms.js";
import { isRuleBasedCopularMeasureValue } from "./result-slots.js";
import { tokenizeFactFrameSource, type FactFrameSourceToken } from "./source-text.js";

export type InterrogativeCueScan = Readonly<{
  readonly interrogative: boolean;
  readonly ambiguous_wh: boolean;
  readonly time_requested: boolean;
  readonly type_requested: boolean;
}>;

const TIME_WH: ReadonlySet<string> = new Set(["when"]);
const CJK_TIME_CUES = ["几点", "什么时候"] as const;
export const CJK_INTERROGATIVE_CUES = [
  ...CJK_INTERROGATIVE_RESULT_FORMS,
  ...CJK_TIME_CUES,
  "什么", "谁", "哪", "几", "吗", "多大", "多少"
] as const;

export function scanInterrogativeCues(query: string): InterrogativeCueScan {
  const tokens = tokenizeFactFrameSource(query);
  const whTokens = tokens.filter((token) => WH_WORDS.has(token.normalized));
  const cjkInterrogative = CJK_INTERROGATIVE_CUES.some((cue) => query.includes(cue));
  return Object.freeze({
    interrogative: whTokens.length > 0 || cjkInterrogative,
    ambiguous_wh: whTokens.length > 1 || hasCoordinatedWh(tokens),
    time_requested: whTokens.some((token) => TIME_WH.has(token.normalized)) ||
      CJK_TIME_CUES.some((cue) => query.includes(cue)),
    type_requested: hasEnglishTypeNoun(tokens)
  });
}

export function extractAnswerOperatorSlot(
  query: string,
  valueSpan: readonly [number, number]
): Readonly<{ surface: string; source_span: readonly [number, number] }> | "ambiguous" | null {
  const tokens = tokensInSpan(tokenizeFactFrameSource(query), valueSpan);
  const whTokens = tokens.filter((token) => WH_WORDS.has(token.normalized));
  if (whTokens.length > 1 || hasCoordinatedWh(tokens)) return "ambiguous";
  if (tokens.length === 0) return null;
  const surface = query.slice(valueSpan[0], valueSpan[1]);
  if (isRuleBasedCopularMeasureValue(surface) ||
      (tokens.length === 1 && tokens[0]!.normalized === "where")) {
    return span(query, tokens[0]!.start, tokens.at(-1)!.end);
  }
  const first = tokens[0]!;
  if (WH_WORDS.has(first.normalized)) return span(query, first.start, first.end);
  return span(query, valueSpan[0], valueSpan[1]);
}

export function isTimeAnswerOperator(surface: string): boolean {
  const tokens = tokenizeFactFrameSource(surface);
  return (tokens.length === 1 && TIME_WH.has(tokens[0]!.normalized)) ||
    CJK_TIME_CUES.some((cue) => surface.includes(cue));
}

export function extractTypeConstraintSlot(
  query: string,
  valueSpan: readonly [number, number]
): Readonly<{ surface: string; source_span: readonly [number, number] }> | null {
  const tokens = tokensInSpan(tokenizeFactFrameSource(query), valueSpan);
  if (tokens.length < 2 || !WH_WORDS.has(tokens[0]!.normalized)) return null;
  const rest = tokens.slice(1);
  const surface = query.slice(valueSpan[0], valueSpan[1]);
  if (isRuleBasedCopularMeasureValue(surface) || rest.length === 0) return null;
  if (rest.every((token) => WH_WORDS.has(token.normalized) ||
      token.normalized === "and" || token.normalized === "or")) {
    return null;
  }
  return span(query, rest[0]!.start, rest.at(-1)!.end);
}

function hasEnglishTypeNoun(tokens: readonly FactFrameSourceToken[]): boolean {
  const firstWh = tokens.findIndex((token) => WH_WORDS.has(token.normalized));
  if (firstWh < 0) return false;
  const next = tokens[firstWh + 1];
  return next !== undefined && !WH_WORDS.has(next.normalized) &&
    !AUXILIARIES.has(next.normalized) &&
    next.normalized !== "and" && next.normalized !== "or" &&
    !isRuleBasedCopularMeasureValue(
      `${tokens[firstWh]!.text} ${next.text}`
    );
}

function hasCoordinatedWh(tokens: readonly FactFrameSourceToken[]): boolean {
  return tokens.some((token, index) => {
    const prev = tokens[index - 1];
    const next = tokens[index + 1];
    return (token.normalized === "and" || token.normalized === "or") &&
      prev !== undefined && next !== undefined &&
      WH_WORDS.has(prev.normalized) && WH_WORDS.has(next.normalized);
  });
}

function tokensInSpan(
  tokens: readonly FactFrameSourceToken[],
  spanRange: readonly [number, number]
): readonly FactFrameSourceToken[] {
  return tokens.filter((token) =>
    token.start >= spanRange[0] && token.end <= spanRange[1]);
}

function span(query: string, start: number, end: number) {
  return Object.freeze({
    surface: query.slice(start, end),
    source_span: Object.freeze([start, end] as const)
  });
}
