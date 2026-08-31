import type {
  OfficialApiExtractionRequest,
  OfficialApiSignalDraft
} from "@do-soul/alaya-soul";

export function rebindDraftToCurrentAssertionCatalog(
  draft: OfficialApiSignalDraft,
  request: OfficialApiExtractionRequest,
  requiredAssertionIds?: ReadonlySet<number>
): OfficialApiSignalDraft | null {
  const assertion = resolveUniqueAssertion(
    draft.matched_text,
    request,
    requiredAssertionIds
  );
  return assertion === null ? null : Object.freeze({
    ...draft,
    source_locator: Object.freeze({
      contract_version: 2 as const,
      kind: "assertion_catalog" as const,
      assertion_id: assertion.assertion_id
    })
  });
}

function resolveUniqueAssertion(
  matchedText: string,
  request: OfficialApiExtractionRequest,
  requiredAssertionIds: ReadonlySet<number> | undefined
): OfficialApiExtractionRequest["source_assertions"][number] | null {
  const matched = matchedText.trim();
  const catalog = request.source_assertions.map((assertion) => Object.freeze({
    assertion,
    normalizedText: normalizeAssertionText(assertion.text)
  }));
  const exact = catalog.filter(({ normalizedText }) => normalizedText === matched);
  const containing = exact.length > 0 ? exact : catalog.filter(({ normalizedText }) =>
    normalizedText.includes(matched)
  );
  const shortestLength = Math.min(...containing.map(({ normalizedText }) =>
    normalizedText.length
  ));
  const candidates = containing.filter(({ normalizedText }) =>
    normalizedText.length === shortestLength
  ).map(({ assertion }) => assertion);
  if (candidates.length > 1) {
    if (requiredAssertionIds === undefined || !candidates.some((candidate) =>
      requiredAssertionIds.has(candidate.assertion_id)
    )) return null;
    throw new Error("source assertion supplement matched text is ambiguous in current catalog");
  }
  return candidates[0] ?? null;
}

function normalizeAssertionText(value: string): string {
  return value.trim().replace(/^(?:User|Assistant):\s*/u, "");
}
