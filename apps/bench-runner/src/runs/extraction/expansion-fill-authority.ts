import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from
  "../../datasets/longmemeval/ingestion/dataset.js";
import type { LongMemEvalExpansionCapability } from
  "../../datasets/longmemeval/promotion/expansion/expansion-capability.js";
import type {
  R3SpendApproval,
  VerifiedR3SpendApproval
} from "../../datasets/longmemeval/promotion/r3-spend-approval.js";
import type { LongMemEvalExpansionLineage } from
  "../../datasets/longmemeval/promotion/expansion/lineage/expansion-lineage-schema.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../../datasets/longmemeval/promotion/expansion/lineage/expansion-source-anchor-schema.js";
import type { ExtractionCacheManifest } from "./cache/extraction-cache-manifest.js";
import type { ExtractionFillCompletion } from "./fill/fill-completion.js";
import type { LongMemEvalExtractionTurn } from "./turn-contents.js";

export interface ExpansionFillAuthorityOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
  readonly r3SpendApproval?: R3SpendApproval;
}

export interface PreparedExpansionFillAuthority {
  readonly capability: LongMemEvalExpansionCapability;
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly datasetRevision: string;
  readonly sourceAnchor: LongMemEvalExpansionSourceAnchor;
  readonly r3SpendApproval: VerifiedR3SpendApproval;
  readonly sourceTurns: readonly LongMemEvalExtractionTurn[];
  readonly nextTurns: readonly LongMemEvalExtractionTurn[];
  readonly nextQuestions: readonly LongMemEvalQuestion[];
}

export async function prepareExpansionFillAuthority(
  options: ExpansionFillAuthorityOptions,
  _cacheRoot: string
): Promise<PreparedExpansionFillAuthority | undefined> {
  if (options.expansionCapability !== undefined || options.r3SpendApproval !== undefined) {
    throw new Error("expansion fill is not supported");
  }
  return undefined;
}

export function revalidateExpansionFillAuthority(
  _authority: PreparedExpansionFillAuthority
): void {
  throw new Error("expansion fill is not supported");
}

export function finalizeExpansionFillAuthority(
  _authority: PreparedExpansionFillAuthority,
  _manifest: ExtractionCacheManifest,
  _completion: ExtractionFillCompletion
): LongMemEvalExpansionLineage {
  throw new Error("expansion fill is not supported");
}
