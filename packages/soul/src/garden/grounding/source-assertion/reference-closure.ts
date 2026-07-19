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

function isLocallyClosedReference(assertion: string, reference: string, index: number): boolean {
  const before = assertion.slice(0, index);
  const after = assertion.slice(index + reference.length);
  switch (reference.toLocaleLowerCase("en-US")) {
    case "it":
      return isDummyIt(before, after) || hasLocalObjectAntecedent(before) ||
        hasLocalPlaceAntecedent(before);
    case "there":
      return hasLocalPlaceAntecedent(before);
    case "her":
    case "hers":
      return hasLocalKinshipAntecedent(before, "female");
    case "him":
    case "his":
    case "he":
      return hasLocalKinshipAntecedent(before, "male");
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

function hasCoordinatedObjectAmbiguity(before: string): boolean {
  return /\b(?:a|an|the|my|this|that)\s+[\p{L}\p{N}'’-]+(?:\s+[\p{L}\p{N}'’-]+){0,3}\s+and\s+(?:a|an|the|my|this|that)\s+[\p{L}\p{N}'’-]+/iu.test(
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
    /^\s+(?:cost|costs|took|takes|made|makes|has|had|includes?|involves?)\b/iu.test(after) ||
    /^\s+\p{Ll}[\p{L}'’-]*(?:s|ed)\b/u.test(after);
}

function isComplementThat(before: string, after: string): boolean {
  return /\b(?:found|find|think|thought|know|knew|said|say|believe|believed|remember|recalled)\s*$/iu.test(
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
