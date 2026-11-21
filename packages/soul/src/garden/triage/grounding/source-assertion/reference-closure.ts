import { stripSourceRoleMarker } from "../source-role/marker.js";

const ENGLISH_REFERENCE =
  /\b(?:he|she|it|they|him|her|them|his|hers|their|there|here|this|that|these|those|aforementioned|such)\b/giu;

export function hasUnresolvedReference(assertion: string): boolean {
  if (hasUnresolvedChineseReference(assertion)) return true;
  if (/\bthe\s+(?:former|latter|same|above|below)\b/iu.test(assertion)) return true;
  for (const match of assertion.matchAll(ENGLISH_REFERENCE)) {
    if (!isLocallyClosedReference(assertion, match[0]!, match.index)) return true;
  }
  return false;
}

/**
 * A span created by removing conversational wrapper text cannot borrow the
 * omitted turn context to close a request or interlocutor reference.
 */
export function isLocallyClosedAtomicAssertion(assertion: string): boolean {
  const value = stripSourceRoleMarker(assertion);
  return !hasUnresolvedReference(value) && !hasAtomicConversationDependency(value);
}

function hasAtomicConversationDependency(assertion: string): boolean {
  return /^(?:I\s+was|I\s+am|I['’]m)\s+(?:just\s+)?wondering\s+(?:if|whether)\b/iu.test(assertion) ||
    /^I(?:['’]ll|\s+will)\s+(?:let\s+you\s+know|keep\s+you\s+posted|tell\s+you)\b/iu.test(assertion) ||
    hasUnclosedAtomicInterlocutorReference(assertion) ||
    hasUnanchoredAtomicEvaluation(assertion) ||
    /\b(?:someone|something|anyone|anything|nothing|everything)\s+else\b/iu.test(assertion);
}

function hasUnclosedAtomicInterlocutorReference(assertion: string): boolean {
  if (/\byou\b/iu.test(assertion)) return true;
  if (/\byours\b/iu.test(assertion)) return true;
  for (const match of assertion.matchAll(/\byour\s+([^,.!?;\n]{0,120})/giu)) {
    const phrase = match[1]!.split(/\b(?:and|but|or|so)\b/iu, 1)[0] ?? "";
    if (!/\b(?:called|named|titled|known\s+as)\s+(?:["“][^"”]{1,80}["”]|\p{Lu}[\p{L}\p{N}'’-]*(?:\s+\p{Lu}[\p{L}\p{N}'’-]*){0,5})/u.test(phrase)) {
      return true;
    }
  }
  return false;
}

function hasUnanchoredAtomicEvaluation(assertion: string): boolean {
  return /\b(?:I|we)\s+(?:(?:really|just|quite|so)\s+)?(?:enjoyed|liked|loved|hated|appreciated)\s+the\s+\p{Ll}[\p{L}\p{N}'’-]*\s*[.!]?$/iu.test(assertion);
}

function isLocallyClosedReference(assertion: string, reference: string, index: number): boolean {
  const before = assertion.slice(0, index);
  const after = assertion.slice(index + reference.length);
  switch (reference.toLocaleLowerCase("en-US")) {
    case "it":
      return isDummyIt(before, after) || hasLocalObjectAntecedent(before) ||
        hasLocalPlaceAntecedent(before) || hasLocalValuationTopic(before, after);
    case "there":
      return hasLocalPlaceAntecedent(before);
    case "her":
    case "hers":
      return hasLocalKinshipAntecedent(before, "female");
    case "him":
    case "his":
      return hasLocalKinshipAntecedent(before, "male");
    case "he":
      return hasLocalKinshipAntecedent(before, "male");
    case "them":
      return false;
    case "that":
      return isRelativeThat(before, after) || isComplementThat(before, after) ||
        isAnchoredDemonstrative(after);
    case "this":
      return isAnchoredDemonstrative(after);
    case "these":
    case "those":
      return isAnchoredDemonstrative(after) || hasLocalPluralAntecedent(before) ||
        isNamedCollectionContents(before, after);
    default:
      return false;
  }
}

function isDummyIt(before: string, after: string): boolean {
  if (/^\s+(?:took|takes|will\s+take)\b/iu.test(after)) return true;
  if (/^\s*(?:['’]s|is|was|will\s+be)\s+(?:possible|likely|clear|important|necessary)\b/iu.test(after)) {
    return true;
  }
  return /^\s*(?:['’]s|is|was|will\s+be)\s+worth\b/iu.test(after) &&
    /\b(?:effort|time|work|trip|move|drive)\b/iu.test(before);
}

function hasLocalObjectAntecedent(before: string): boolean {
  if (!/(?:,\s*|\s+)(?:and|but|because|since)\s*$/iu.test(before)) return false;
  if (hasCoordinatedObjectAmbiguity(before)) return false;
  return /\b(?:made|got|bought|created|redeemed|picked\s+up|using|listening\s+to)\b[\s\S]{1,180}$/iu.test(
    before
  );
}

function hasLocalValuationTopic(before: string, after: string): boolean {
  const match = /\b(?:thinking|thought)\s+about\s+(?:my|our|the)\s+([^,]{1,120}),\s+and\s+I\s+(?:realized|noticed|learned|discovered|found)\s+that\b/iu.exec(before);
  if (match === null || !isSimpleValuationTopic(match[1]!)) return false;
  if (/^\s*(?:['’]s|is|was)\s+(?:actually\s+)?worth\b/iu.test(after)) return true;
  return /\bworth\b[\s\S]{0,100}\bwhat\s+I\s+paid\s+for\s*$/iu.test(before);
}

function isSimpleValuationTopic(topic: string): boolean {
  const words = topic.trim().split(/\s+/u);
  if (words.length === 0 || words.length > 5) return false;
  return !/\b(?:and|or|of|with|for|from|to|in|on|at|by)\b/iu.test(topic);
}

function hasCoordinatedObjectAmbiguity(before: string): boolean {
  if (/\b(?:a|an|the|my|this|that)\s+[\p{L}\p{N}'’-]+(?:\s+[\p{L}\p{N}'’-]+){0,3}\s+and\s+(?:a|an|the|my|this|that)\s+[\p{L}\p{N}'’-]+/iu.test(
    before
  )) return true;
  return /\b(?:my|our|the|this|that)\s+(?:\p{Ll}[\p{L}'’-]+\s+){0,2}\p{Ll}[\p{L}'’-]+\s+(?:and|or)\s+(?:\p{Ll}[\p{L}'’-]+\s+){0,2}\p{Ll}[\p{L}'’-]+\b/u.test(
    before
  );
}

function hasLocalPlaceAntecedent(before: string): boolean {
  const anchors = [...before.matchAll(
    /\b(?:in|at|to|from|near|around|back\s+to)\s+(?:the\s+)?\p{Lu}[\p{L}\p{N}'’.]*(?:\s+\p{Lu}[\p{L}\p{N}'’.]*){0,5}\b/gu
  )];
  if (anchors.length === 1) return true;
  if (anchors.length < 2) return false;
  return anchors.slice(1).every((anchor, index) => {
    const previous = anchors[index]!;
    const previousEnd = previous.index + previous[0].length;
    return /^in\b/iu.test(anchor[0]) && /^\s*$/u.test(before.slice(previousEnd, anchor.index));
  });
}

function hasLocalKinshipAntecedent(before: string, gender: "female" | "male"): boolean {
  const nouns = gender === "female"
    ? "sister|mother|daughter|aunt|niece|wife|girlfriend|woman|girl"
    : "brother|father|son|uncle|nephew|husband|boyfriend|man|boy";
  return [...before.matchAll(new RegExp(`\\b(?:my|the)\\s+(?:${nouns})\\b`, "giu"))].length === 1;
}

function isRelativeThat(before: string, after: string): boolean {
  if (!/[\p{L}\p{N}'’]([),]?)\s*$/u.test(before)) return false;
  return /^\s+(?:I|we|you|he|she|they|it|am|is|are|was|were)\b/iu.test(after) ||
    /^\s+(?:can|could|may|might|must|shall|should|will|would)(?:\s+not)?\s+[\p{L}'’-]+\b/iu.test(after) ||
    /^\s+(?:cost|costs|took|takes|made|makes|has|had|includes?|involves?)\b/iu.test(after) ||
    /^\s+\p{Ll}[\p{L}'’-]*(?:s|ed)\b/u.test(after);
}

function isComplementThat(before: string, after: string): boolean {
  return /\b(?:found|find|think|thought|know|knew|said|say|believe|believed|remember|recalled|realize|realized|notice|noticed|learn|learned|discover|discovered)\s*$/iu.test(
    before
  ) && /^\s+[\p{L}\p{N}]/u.test(after);
}

function hasLocalPluralAntecedent(before: string): boolean {
  return /\b\d+\s+(?:[\p{L}'’-]+\s+){0,4}[\p{L}'’-]+s\b/iu.test(before);
}

function isNamedCollectionContents(before: string, after: string): boolean {
  if (!/\b(?:it\s+has|it['’]s\s+got|it\s+contains)\s+all\s*$/iu.test(before)) return false;
  if (!/^\s+(?:[\p{L}'’-]+\s+){1,4}[\p{L}'’-]+\b/u.test(after)) return false;
  return /\b(?:called|named)\s+\p{Lu}[\p{L}\p{N}'’-]*(?:\s+\p{Lu}[\p{L}\p{N}'’-]*){0,5}\b/u.test(
    before
  );
}

function isAnchoredDemonstrative(after: string): boolean {
  const nounPhrase = after.split(/[,.!?;]|\b(?:and|but|or|so)\b/iu, 1)[0] ?? "";
  return /\b(?:called|named|in|on|at|from)\s+(?:the\s+)?(?:\p{Lu}[\p{L}\p{N}'’-]*)(?:\s+\p{Lu}[\p{L}\p{N}'’-]*){0,5}\b/u.test(
    nounPhrase
  ) || /["“][^"”]+["”]/u.test(nounPhrase);
}

function hasUnresolvedChineseReference(assertion: string): boolean {
  if (/(?:这里|那里|前者|后者|上述|下述|同上|同下|如此|其人)/u.test(assertion)) {
    return true;
  }
  if (/(?:这|那)(?=\p{Script=Han})/u.test(assertion)) return true;
  return /(?<!应|活)(?:该|此)(?=\p{Script=Han})/u.test(assertion);
}

export function startsWithChineseThirdPersonSubject(assertion: string): boolean {
  return /^(?:他(?:们)?|她(?:们)?|它(?:们)?)(?=[\p{L}\p{N}])/u.test(assertion.trim());
}
