import type { VerifiedUserAssertionCatalogLocator } from "@do-soul/alaya-protocol";
import {
  parseOfficialApiSourceLocator,
  resolveOfficialApiSourceLocatorQuote,
  sourceAssertionMaxChars
} from "../source-locator.js";

export function verifyOfficialApiSourceLocatorBinding(input: Readonly<{
  readonly sourceCorpus: string;
  readonly sourceAssertion: string;
  readonly sourceLocator: VerifiedUserAssertionCatalogLocator;
}>): boolean {
  const locator = parseOfficialApiSourceLocator(input.sourceLocator);
  if (locator === null) return false;
  const resolution = resolveOfficialApiSourceLocatorQuote(
    input.sourceCorpus,
    locator,
    input.sourceAssertion,
    sourceAssertionMaxChars(input.sourceAssertion)
  );
  return resolution.status === "grounded" &&
    resolution.assertion === input.sourceAssertion;
}
