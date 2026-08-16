import type { AddressableSourceSpanPurpose } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";

export type SourceSpanDraft = Readonly<{
  readonly start_offset: number;
  readonly end_offset: number;
  readonly purpose: AddressableSourceSpanPurpose;
}>;

export function deriveAddressableSpanViews(content: string): readonly SourceSpanDraft[] {
  if (content.length === 0) return Object.freeze([]);
  return Object.freeze([
    { start_offset: 0, end_offset: content.length, purpose: "native_structure" },
    ...lineSpanDrafts(content),
    ...sentenceSpanDrafts(content)
  ]);
}

export function assertSpanInContent(
  content: string,
  span: SourceSpanDraft
): SourceSpanDraft {
  if (span.end_offset <= span.start_offset) {
    throw rangeError("addressable source span must be half-open and non-empty");
  }
  if (span.start_offset < 0 || span.end_offset > content.length) {
    throw rangeError("addressable source span is outside the source bytes");
  }
  return span;
}

function lineSpanDrafts(content: string): readonly SourceSpanDraft[] {
  const drafts: SourceSpanDraft[] = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    if (end > start) {
      drafts.push({ start_offset: start, end_offset: end, purpose: "line" });
    }
    if (newline === -1) break;
    start = end + 1;
  }
  return drafts;
}

function sentenceSpanDrafts(content: string): readonly SourceSpanDraft[] {
  const drafts: SourceSpanDraft[] = [];
  const pattern = /[^.!?]+(?:[.!?]+|(?=$))/gu;
  for (const match of content.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const trimmed = trimSpan(content, start, start + raw.length);
    if (trimmed !== null) {
      drafts.push({ ...trimmed, purpose: "sentence" });
    }
  }
  return drafts;
}

function trimSpan(
  content: string,
  start: number,
  end: number
): Omit<SourceSpanDraft, "purpose"> | null {
  let left = start;
  let right = end;
  while (left < right && /\s/u.test(content.charAt(left))) left += 1;
  while (right > left && /\s/u.test(content.charAt(right - 1))) right -= 1;
  return right > left ? { start_offset: left, end_offset: right } : null;
}

function rangeError(message: string): CoreError {
  return new CoreError("VALIDATION", message);
}
