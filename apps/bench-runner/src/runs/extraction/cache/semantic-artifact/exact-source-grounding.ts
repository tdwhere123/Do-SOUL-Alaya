import {
  officialApiSemanticWorksetFromUnits,
  parseOfficialApiSourceLocator,
  resolveOfficialApiSourceLocatorQuote,
  type OfficialApiSemanticWorkUnit
} from "@do-soul/alaya-soul";

type OfficialApiSourceLocator = NonNullable<
  ReturnType<typeof parseOfficialApiSourceLocator>
>;

export type ExactSourceGroundingTask = OfficialApiSemanticWorkUnit & Readonly<{
  sourceCorpus: string;
  semanticIdentity: NonNullable<OfficialApiSemanticWorkUnit["semanticIdentity"]>;
}>;

export type ExactSourceGrounding =
  | Readonly<{ status: "grounded"; locator: OfficialApiSourceLocator }>
  | Readonly<{ status: "rejected"; assertionId?: number; reason: string }>;

/**
 * The single quote/locator admission rule shared by live fills and sealed
 * legacy conversion. A locator is not evidence by itself: the proposed quote
 * must be the exact catalog assertion carried by the verified semantic unit.
 */
export function resolveExactSourceGrounding(input: {
  readonly task: ExactSourceGroundingTask;
  readonly sourceLocator: unknown;
  readonly matchedText: string;
}): ExactSourceGrounding {
  const locator = parseOfficialApiSourceLocator(input.sourceLocator);
  if (locator === null) {
    return Object.freeze({ status: "rejected", reason: "malformed source locator" });
  }
  const task = input.task;
  try {
    if (typeof task.sourceCorpus !== "string" ||
        typeof task.binding !== "object" || task.binding === null ||
        typeof task.semanticIdentity !== "object" || task.semanticIdentity === null) {
      throw new TypeError("semantic work unit is missing its v2 identity witness");
    }
    officialApiSemanticWorksetFromUnits([task]);
    if (locator.assertion_id !== task.assertionId ||
        locator.contract_version !== task.binding.locator.contract_version ||
        locator.contract_version !== task.semanticIdentity.formationContractVersion ||
        task.binding.semanticKey !== task.semanticKey) {
      return Object.freeze({
        status: "rejected",
        assertionId: locator.assertion_id,
        reason: "source locator does not match semantic source binding"
      });
    }
  } catch (cause) {
    return Object.freeze({
      status: "rejected",
      assertionId: locator.assertion_id,
      reason: errorMessage(cause)
    });
  }
  const exactAssertion = task.text.replace(/^(?:User|Assistant): /u, "");
  const grounding = resolveOfficialApiSourceLocatorQuote(
    task.sourceCorpus,
    locator,
    input.matchedText
  );
  if (grounding.status !== "grounded") {
    return Object.freeze({
      status: "rejected",
      assertionId: locator.assertion_id,
      reason: grounding.reason
    });
  }
  if (input.matchedText !== exactAssertion || grounding.assertion !== exactAssertion) {
    return Object.freeze({
      status: "rejected",
      assertionId: locator.assertion_id,
      reason: "matched_text is not the exact source assertion"
    });
  }
  return Object.freeze({ status: "grounded", locator });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
