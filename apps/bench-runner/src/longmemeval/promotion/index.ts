import { realpath } from "node:fs/promises";
import path from "node:path";
import { loadDatasetWithIdentity } from "../ingestion/fetch.js";
import { classifyLongMemEvalDatasetCohort } from "../selection/dataset-cohort.js";
import {
  createLongMemEvalSelectionContractFromAssignments,
  selectionContractIdentity
} from "../selection/contract.js";
import {
  assertStablePromotionValidatorIdentity,
  DEFAULT_PROMOTION_CODE_IDENTITY_DEPENDENCIES,
  resolveCurrentPromotionValidatorIdentity,
  type PromotionCodeIdentityDependencies,
  type PromotionCodeIdentityInput
} from "./assert-current-code-identity.js";
import {
  parseLongMemEvalMatrixPromotionContract,
  type LongMemEvalMatrixPromotionContract
} from "./schema/contract.js";
import {
  verifyRecallEvalPromotionEntry
} from "./verifiers/entry-verifier.js";
import { authorizeVerifiedLongMemEvalMatrix } from "./schema/matrix-validator.js";
import type { LongMemEvalMatrixPromotionAuthorization } from "./schema/authorization.js";
import { verifyPromotionSnapshot } from "./verifiers/snapshot-verifier.js";

export {
  LongMemEvalMatrixPromotionAuthorizationSchema,
  LongMemEvalMatrixPromotionRejectionSchema,
  renderLongMemEvalMatrixPromotionAuthorization,
  renderLongMemEvalMatrixPromotionRejection,
  type LongMemEvalMatrixPromotionAuthorization,
  type LongMemEvalMatrixPromotionRejection,
  type PromotionValidatorIdentity
} from "./schema/authorization.js";
export {
  LongMemEvalMatrixPromotionContractSchema,
  parseLongMemEvalMatrixPromotionContract,
  type LongMemEvalMatrixPromotionContract
} from "./schema/contract.js";
export {
  resolveCurrentPromotionValidatorIdentity,
  type PromotionCodeIdentityDependencies
} from "./assert-current-code-identity.js";

export interface LongMemEvalMatrixPromotionAuthorizeInput
  extends PromotionCodeIdentityInput {
  readonly contractRoot: string;
  readonly contractContents: string | Uint8Array;
}

export type LongMemEvalMatrixPromotionAuthorizeDependencies =
  PromotionCodeIdentityDependencies;

export async function authorizeLongMemEvalMatrixPromotion(
  input: LongMemEvalMatrixPromotionAuthorizeInput,
  dependencies: LongMemEvalMatrixPromotionAuthorizeDependencies =
    DEFAULT_PROMOTION_CODE_IDENTITY_DEPENDENCIES
): Promise<LongMemEvalMatrixPromotionAuthorization> {
  const parsed = parseLongMemEvalMatrixPromotionContract(input.contractContents);
  const validatorBefore = await resolveCurrentPromotionValidatorIdentity(
    input,
    parsed,
    dependencies
  );
  const selections = await loadPromotionSelections(parsed.contract);
  const snapshot = await verifyPromotionSnapshot({
    contractRoot: input.contractRoot,
    snapshot: parsed.contract.snapshot,
    expectedSelection: selections.source,
    expectedQuestions: selections.sourceQuestions,
    variant: parsed.contract.dataset.variant,
    code: parsed.contract.code
  });
  const roots = await resolveEntryRoots(input.contractRoot, parsed.contract);
  const cells = await verifyPromotionEntries(parsed, roots, selections.source, snapshot);
  const validator = await resolveCurrentPromotionValidatorIdentity(
    input,
    parsed,
    dependencies
  );
  assertStablePromotionValidatorIdentity(validatorBefore, validator);
  return authorizeVerifiedLongMemEvalMatrix({
    contract: parsed.contract,
    contractSha256: parsed.sha256,
    sourceSelection: selections.source,
    nextSelection: selections.next,
    cells,
    validator
  });
}

async function loadPromotionSelections(contract: LongMemEvalMatrixPromotionContract) {
  const dataset = await loadDatasetWithIdentity(contract.dataset.variant);
  if (dataset.promotionAuthority === null) {
    throw new Error("promotion requires the repository-pinned canonical dataset authority");
  }
  const assignments = dataset.questions.map((question) => ({
    question_id: question.question_id,
    dataset_cohort: classifyLongMemEvalDatasetCohort(question)
  }));
  if (assignments.length !== contract.selection.target_full_count) {
    throw new Error("promotion target must be the canonical 500-question full dataset");
  }
  const sourceContract = createLongMemEvalSelectionContractFromAssignments({
    datasetSha256: dataset.sha256,
    assignments: assignments.slice(0, contract.selection.source_prefix_count)
  });
  return {
    source: selectionContractIdentity(sourceContract),
    sourceQuestions: dataset.questions.slice(0, contract.selection.source_prefix_count),
    next: selectionContractIdentity(
      createLongMemEvalSelectionContractFromAssignments({
        datasetSha256: dataset.sha256,
        assignments
      })
    )
  };
}

async function verifyPromotionEntries(
  parsed: ReturnType<typeof parseLongMemEvalMatrixPromotionContract>,
  roots: ReadonlyMap<string, string>,
  sourceSelection: ReturnType<typeof selectionContractIdentity>,
  snapshot: Parameters<typeof verifyRecallEvalPromotionEntry>[0]["snapshot"]
) {
  return Promise.all(parsed.contract.matrix.entries.map((entry) =>
    verifyDeclaredPromotionEntry(parsed, roots, sourceSelection, snapshot, entry)));
}

async function verifyDeclaredPromotionEntry(
  parsed: ReturnType<typeof parseLongMemEvalMatrixPromotionContract>,
  roots: ReadonlyMap<string, string>,
  sourceSelection: ReturnType<typeof selectionContractIdentity>,
  snapshot: Parameters<typeof verifyRecallEvalPromotionEntry>[0]["snapshot"],
  declared: LongMemEvalMatrixPromotionContract["matrix"]["entries"][number]
) {
  const entry = await verifyRecallEvalPromotionEntry({
    entryRoot: roots.get(declared.evidence_root)!,
    expectedSelection: sourceSelection,
    treatment: declared.treatment,
    code: parsed.contract.code,
    gateSha256: parsed.sha256,
    snapshot
  });
  return { evidenceRoot: declared.evidence_root, entry };
}

async function resolveEntryRoots(
  contractRoot: string,
  contract: LongMemEvalMatrixPromotionContract
): Promise<ReadonlyMap<string, string>> {
  const root = await realpath(contractRoot);
  const entries = await Promise.all(contract.matrix.entries.map(async (entry) => {
    const resolved = await realpath(path.resolve(root, entry.evidence_root));
    const relative = path.relative(root, resolved);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`promotion evidence root escapes contract root: ${entry.evidence_root}`);
    }
    return [entry.evidence_root, resolved] as const;
  }));
  return new Map(entries);
}
