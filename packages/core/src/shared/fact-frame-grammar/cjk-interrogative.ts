import {
  AssociativeFactFrameSchema,
  type AssociativeFactFrame,
  type AssociativeFactSlot,
  type AssociativeFactSlotRole
} from "@do-soul/alaya-protocol";
import { CJK_LOCATIVE_LINKER_FORM } from "./cjk-interrogative-forms.js";
import {
  isCjkCopularMeasureTokens,
  isCjkLocationResultToken,
  isRuleBasedCopularPredicate
} from "./result-slots.js";
import type { FactFrameSourceToken } from "./source-text.js";

type CjkOsfLayout = Readonly<{
  readonly value: Readonly<{ surface: string; source_span: readonly [number, number] }>;
  readonly subject: Readonly<{ surface: string; source_span: readonly [number, number] }>;
  readonly predicate: Readonly<{ surface: string; source_span: readonly [number, number] }>;
  readonly constraints: readonly Readonly<{
    surface: string; source_span: readonly [number, number]
  }>[];
}>;

const LOCATIVE_LINKER = CJK_LOCATIVE_LINKER_FORM;
const ASPECT_MARKER = "了";

export function parseCjkInterrogativeFactFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[]
): Readonly<{
  readonly frame: Readonly<AssociativeFactFrame>;
  readonly osfLayout: CjkOsfLayout;
}> | null {
  if (tokens.length < 3) return null;
  return parseCjkDurationFrame(query, tokens) ?? parseCjkLocationFrame(query, tokens);
}

function parseCjkDurationFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[]
): Readonly<{
  readonly frame: Readonly<AssociativeFactFrame>;
  readonly osfLayout: CjkOsfLayout;
}> | null {
  const measure = takeTrailingMeasure(tokens);
  if (measure === null || measure.start < 2) return null;
  const predicate = tokens[measure.start - 1]!;
  const subjectTokens = tokens.slice(0, measure.start - 1);
  if (!isRuleBasedCopularPredicate(predicate.text) ||
      subjectTokens.length === 0 ||
      subjectTokens.some((token) => isCjkResultWh(token.normalized))) {
    return null;
  }
  const value = span(query, tokens[measure.start]!.start, tokens[measure.end - 1]!.end);
  const subject = span(query, subjectTokens[0]!.start, subjectTokens.at(-1)!.end);
  const parsed = frame([
    slot("subject", subject.surface),
    slot("relation", predicate.text),
    slot("value", value.surface)
  ]);
  if (parsed === null) return null;
  return Object.freeze({
    frame: parsed,
    osfLayout: Object.freeze({
      value,
      subject,
      predicate: span(query, predicate.start, predicate.end),
      constraints: Object.freeze([])
    })
  });
}

function parseCjkLocationFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[]
): Readonly<{
  readonly frame: Readonly<AssociativeFactFrame>;
  readonly osfLayout: CjkOsfLayout;
}> | null {
  const locationIndex = uniqueLocationIndex(tokens);
  if (locationIndex === null) return null;
  return locationIndex + 1 < tokens.length
    ? parseCjkVerbalLocation(query, tokens, locationIndex)
    : parseCjkCopularLocation(query, tokens, locationIndex);
}

function parseCjkVerbalLocation(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  locationIndex: number
): Readonly<{
  readonly frame: Readonly<AssociativeFactFrame>;
  readonly osfLayout: CjkOsfLayout;
}> | null {
  const locativeBefore = locationIndex > 0 &&
    tokens[locationIndex - 1]!.normalized === LOCATIVE_LINKER;
  const subjectEnd = locativeBefore ? locationIndex - 1 : locationIndex;
  const subjectTokens = tokens.slice(0, subjectEnd);
  const predicate = tokens[locationIndex + 1];
  if (subjectTokens.length === 0 || predicate === undefined ||
      !isOpenCjkRelation(predicate) ||
      subjectTokens.some((token) => isCjkResultWh(token.normalized))) {
    return null;
  }
  let tailStart = locationIndex + 2;
  if (tokens[tailStart]?.normalized === ASPECT_MARKER) tailStart += 1;
  const tail = tokens.slice(tailStart);
  const constraints = tail.length === 0
    ? Object.freeze([])
    : Object.freeze([span(query, tail[0]!.start, tail.at(-1)!.end)]);
  return freezeLocationLayout(
    query, tokens, locationIndex, subjectTokens, predicate, constraints,
    ["subject", "value", "relation"]
  );
}

function parseCjkCopularLocation(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  locationIndex: number
): Readonly<{
  readonly frame: Readonly<AssociativeFactFrame>;
  readonly osfLayout: CjkOsfLayout;
}> | null {
  const linker = tokens[locationIndex - 1];
  const subjectTokens = tokens.slice(0, locationIndex - 1);
  if (linker?.normalized !== LOCATIVE_LINKER || subjectTokens.length === 0 ||
      subjectTokens.some((token) => isCjkResultWh(token.normalized))) {
    return null;
  }
  return freezeLocationLayout(
    query, tokens, locationIndex, subjectTokens, linker, Object.freeze([]),
    ["subject", "relation", "value"]
  );
}

function freezeLocationLayout(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  locationIndex: number,
  subjectTokens: readonly FactFrameSourceToken[],
  predicate: FactFrameSourceToken,
  constraints: CjkOsfLayout["constraints"],
  slotOrder: readonly ("subject" | "relation" | "value")[]
): Readonly<{
  readonly frame: Readonly<AssociativeFactFrame>;
  readonly osfLayout: CjkOsfLayout;
}> | null {
  const value = span(query, tokens[locationIndex]!.start, tokens[locationIndex]!.end);
  const subject = span(query, subjectTokens[0]!.start, subjectTokens.at(-1)!.end);
  const byRole = {
    subject: slot("subject", subject.surface),
    relation: slot("relation", predicate.text),
    value: slot("value", value.surface)
  };
  const parsed = frame(slotOrder.map((role) => byRole[role]));
  if (parsed === null) return null;
  return Object.freeze({
    frame: parsed,
    osfLayout: Object.freeze({
      value,
      subject,
      predicate: span(query, predicate.start, predicate.end),
      constraints
    })
  });
}

function takeTrailingMeasure(
  tokens: readonly FactFrameSourceToken[]
): Readonly<{ readonly start: number; readonly end: number }> | null {
  for (let width = 3; width >= 1; width -= 1) {
    if (tokens.length < width) continue;
    const start = tokens.length - width;
    if (isCjkCopularMeasureTokens(tokens.slice(start))) {
      return Object.freeze({ start, end: tokens.length });
    }
  }
  return null;
}

function uniqueLocationIndex(tokens: readonly FactFrameSourceToken[]): number | null {
  const indexes = tokens.flatMap((token, index) =>
    isCjkLocationResultToken(token.normalized) ? [index] : []);
  return indexes.length === 1 ? indexes[0]! : null;
}

function isCjkResultWh(normalized: string): boolean {
  return isCjkLocationResultToken(normalized) ||
    isCjkCopularMeasureTokens([{ normalized }]);
}

function isOpenCjkRelation(token: FactFrameSourceToken): boolean {
  return token.text.length > 1 &&
    !isRuleBasedCopularPredicate(token.text) &&
    !isCjkResultWh(token.normalized) &&
    token.normalized !== LOCATIVE_LINKER &&
    token.normalized !== ASPECT_MARKER;
}

function span(query: string, start: number, end: number) {
  return Object.freeze({
    surface: query.slice(start, end),
    source_span: Object.freeze([start, end] as const)
  });
}

function slot(role: AssociativeFactSlotRole, text: string): Readonly<AssociativeFactSlot> {
  return Object.freeze({ role, text });
}

function frame(
  slots: readonly Readonly<AssociativeFactSlot>[]
): Readonly<AssociativeFactFrame> | null {
  const parsed = AssociativeFactFrameSchema.safeParse({
    schema_version: 1,
    slots
  });
  return parsed.success ? parsed.data : null;
}
