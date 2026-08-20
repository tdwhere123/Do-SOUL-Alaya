import {
  resolveOfficialApiSourceLocatorQuote,
  sourceAssertionMaxChars,
  type OfficialApiSourceLocator
} from "../source-locator.js";

export function verifyOfficialApiSourceLocatorBinding(input: Readonly<{
  readonly sourceCorpus: string;
  readonly sourceAssertion: string;
  readonly sourceLocator: OfficialApiSourceLocator;
}>): boolean {
  const resolution = resolveOfficialApiSourceLocatorQuote(
    input.sourceCorpus,
    input.sourceLocator,
    input.sourceAssertion,
    sourceAssertionMaxChars(input.sourceAssertion)
  );
  return resolution.status === "grounded" &&
    resolution.assertion === input.sourceAssertion;
}
