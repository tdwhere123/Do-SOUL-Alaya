const ENGLISH_REFERENCE =
  /\b(?:he|she|it|they|him|her|them|his|hers|their|there|here|this|that|these|those|aforementioned|such)\b/giu;

export function hasUnresolvedReference(assertion: string): boolean {
  const template = matchBoundedTemplateSlot(assertion);
  if (hasUnresolvedChineseReference(assertion)) return true;
  if (/\bthe\s+(?:former|latter|same|above|below)\b/iu.test(assertion)) return true;
  for (const match of assertion.matchAll(ENGLISH_REFERENCE)) {
    if (template !== null && isTemplateBoundReference(template, match[0]!, match.index)) continue;
    if (!isLocallyClosedReference(assertion, match[0]!, match.index)) return true;
  }
  return false;
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

export function isBoundedTemplateSlotAssertion(assertion: string): boolean {
  const value = stripRoleLabel(assertion);
  return matchBoundedTemplateSlot(value) !== null && !hasUnresolvedReference(value);
}

interface BoundedTemplateSlotMatch {
  readonly themIndex: number;
  readonly itIndex: number;
}

function matchBoundedTemplateSlot(assertion: string): BoundedTemplateSlotMatch | null {
  const value = stripRoleLabel(assertion);
  const pattern = /^Under\s+["“]How We Met["”],\s+I['’]ll\s+include\s+the\s+location\s+where\s+I\s+met\s+them\.\s+For\s+\p{Lu}[\p{Ll}\p{N}'’-]*,\s+it\s+was\s+((?:a|an|the)\s+[\p{L}\p{N}'’ -]{1,80})[.!]$/u;
  const match = pattern.exec(value);
  if (match === null || !isBoundedTemplatePlaceValue(match[1]!)) return null;
  return {
    themIndex: value.indexOf("them."),
    itIndex: value.indexOf("it was", value.indexOf("them.") + 5)
  };
}

const TEMPLATE_PLACE_PREPOSITIONS = new Set(["at", "in", "near", "on"]);
const TEMPLATE_PLACE_HEAD_NOUNS = new Set([
  "airport", "apartment", "avenue", "bar", "beach", "building", "cafe", "café",
  "center", "centre", "church", "cinema", "city", "clinic", "college", "district",
  "flat", "garden", "gym", "home", "hospital", "hostel", "hotel", "house", "library",
  "mall", "market", "museum", "neighborhood", "neighbourhood", "office", "park",
  "pub", "restaurant", "road", "room", "school", "shop", "square", "station", "store",
  "street", "theater", "theatre", "town", "trail", "university", "venue", "village"
]);
const TEMPLATE_PLACE_FORBIDDEN_WORDS = new Set([
  "a", "an", "and", "or", "its", "their", "his", "her", "our", "my", "your",
  "other", "previous", "former", "latter", "same", "aforementioned", "above", "below",
  "such", "this", "that", "these", "those", "by", "of", "with", "from", "to", "for",
  "is", "was", "are", "were", "has", "had", "have", "does", "did", "will", "would",
  "should", "could", "can", "may", "might", "must"
]);

function isBoundedTemplatePlaceValue(value: string): boolean {
  const [article, ...rawWords] = value.trim().split(/\s+/u);
  if (!/^(?:a|an|the)$/iu.test(article ?? "") || rawWords.length === 0) return false;
  if (rawWords.some((word) => !/^[\p{L}\p{N}'’–-]+$/u.test(word))) return false;
  const words = rawWords.map((word) => word.toLocaleLowerCase("en-US"));
  if (words.some((word) => TEMPLATE_PLACE_FORBIDDEN_WORDS.has(word))) return false;
  const prepositionIndexes = words.flatMap((word, index) =>
    TEMPLATE_PLACE_PREPOSITIONS.has(word) ? [index] : []
  );
  if (prepositionIndexes.length === 0) {
    return words.length <= 4 && !words.includes("the") && hasBoundedPlaceHead(words);
  }
  if (prepositionIndexes.length !== 1) return false;
  const prepositionIndex = prepositionIndexes[0]!;
  const base = words.slice(0, prepositionIndex);
  const rawTarget = words.slice(prepositionIndex + 1);
  const target = rawTarget[0] === "the" ? rawTarget.slice(1) : rawTarget;
  return base.length >= 1 && base.length <= 4 && !base.includes("the") &&
    target.length >= 1 && target.length <= 4 && !target.includes("the") &&
    hasBoundedPlaceHead(base) && hasBoundedPlaceHead(target);
}

function hasBoundedPlaceHead(words: readonly string[]): boolean {
  const head = words.at(-1);
  return head !== undefined && TEMPLATE_PLACE_HEAD_NOUNS.has(head);
}

function isTemplateBoundReference(
  template: BoundedTemplateSlotMatch,
  reference: string,
  index: number
): boolean {
  return (reference === "them" && index === template.themIndex) ||
    (reference === "it" && index === template.itIndex);
}

function stripRoleLabel(assertion: string): string {
  return assertion.trim().replace(/^(?:User|Assistant)\s*:\s*/iu, "");
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
