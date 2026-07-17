import { isDeepStrictEqual } from "node:util";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "./expansion-capability.js";
import {
  loadDatasetWithIdentity,
  type LoadedLongMemEvalDataset
} from "../../ingestion/fetch.js";
import {
  createLongMemEvalSelectionContract,
  selectionContractIdentity
} from "../../selection/contract.js";

export async function loadCanonicalLongMemEvalExpansionSelection(input: {
  readonly capability: LongMemEvalExpansionCapability;
  readonly variant: "longmemeval_s";
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
}) {
  if (input.pinnedMetaRoot !== undefined) {
    throw new Error("500Q expansion requires the repository-pinned dataset authority");
  }
  const dataset = await loadDatasetWithIdentity(input.variant, {
    dataDir: input.dataDir
  });
  return assertCanonicalLongMemEvalExpansionSelection({
    capability: input.capability,
    dataset
  });
}

export function assertCanonicalLongMemEvalExpansionSelection(input: {
  readonly capability: LongMemEvalExpansionCapability;
  readonly dataset: LoadedLongMemEvalDataset;
}) {
  const { dataset } = input;
  if (dataset.promotionAuthority === null || dataset.questions.length !== 500) {
    throw new Error("500Q expansion requires the canonical full dataset");
  }
  const sourceQuestions = dataset.questions.slice(0, 100);
  const source = selectionContractIdentity(createLongMemEvalSelectionContract({
    datasetSha256: dataset.sha256,
    questions: sourceQuestions
  }));
  const next = selectionContractIdentity(createLongMemEvalSelectionContract({
    datasetSha256: dataset.sha256,
    questions: dataset.questions
  }));
  const authority = longMemEvalExpansionCapabilityData(input.capability);
  if (!isDeepStrictEqual(source, authority.sourceSelection) ||
      !isDeepStrictEqual(next, authority.nextSelection)) {
    throw new Error("canonical dataset selection differs from live expansion authority");
  }
  return Object.freeze({
    dataset,
    sourceQuestions: Object.freeze(sourceQuestions),
    nextQuestions: Object.freeze([...dataset.questions])
  });
}
