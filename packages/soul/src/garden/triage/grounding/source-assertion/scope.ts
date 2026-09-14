import { hasUnquotedSourceDependentScope, isInsideSourceQuotation } from "@do-soul/alaya-protocol";
import { sentenceSpans } from "./clause-spans.js";
import { stripSourceRoleMarker } from "../source-role/marker.js";

/** Scope-bearing sentences remain whole until fragment independence is proven. */
export function sourceAssertionPreservesDependentScope(source: string, start: number, end: number): boolean {
  if (isInsideSourceQuotation(source, start) || isInsideSourceQuotation(source, end)) return false;
  return sentenceSpans(source).every((sentence) => {
    if (sentence.end <= start || sentence.start >= end ||
        !hasUnquotedSourceDependentScope(source, sentence.start, sentence.end)) return true;
    const context = stripSourceRoleMarker(source.slice(sentence.start, sentence.end));
    const retained = stripSourceRoleMarker(source.slice(Math.max(sentence.start, start), Math.min(sentence.end, end)));
    return retained === context || retained === boundedIndirectQuestionPrefix(context);
  });
}

/** The closed conversational question does not condition the preceding travel intention. */
export function boundedIndirectQuestionPrefix(content: string): string | null {
  const kinship = "sister|brother|mother|father|aunt|uncle|cousin|niece|nephew|daughter|son|wife|husband|partner|friend";
  const person = "\\p{Lu}[\\p{L}'’-]*";
  const place = "(?:the\\s+)?\\p{Lu}[\\p{L}\\p{N}'’.-]*(?:\\s+\\p{Lu}[\\p{L}\\p{N}'’.-]*){0,3}";
  const pattern = new RegExp(
    `^((?:I['’]m|I am)\\s+thinking\\s+of\\s+visiting\\s+(?:my|our)\\s+(?:${kinship})\\s+${person}\\s+in\\s+${place}(?:\\s+soon)?),\\s+and\\s+I\\s+was\\s+wondering\\s+(?:if|whether)\\b[^?,;:—–]*\\?$`,
    "u"
  );
  return pattern.exec(content)?.[1]?.trim() ?? null;
}
