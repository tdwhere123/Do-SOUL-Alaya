import type { CapturedSnapshotExtractionAuthority } from
  "../../../../bench/snapshot/extraction-authority.js";
import type { LongMemEvalRunOptions } from "../../../runner.js";
import type { LongMemEvalExpansionCapability } from "../expansion-capability.js";

export interface VerifiedExpansionRunAuthority {
  readonly extraction: CapturedSnapshotExtractionAuthority;
  readonly questionCount: 500;
  readonly fanoutChild: null;
}

export async function assertExpansionRunAuthority(
  options: Pick<LongMemEvalRunOptions, "expansionCapability" | "promotionContractPath">
): Promise<void> {
  if (options.expansionCapability !== undefined || options.promotionContractPath !== undefined) {
    throw new Error("expansion/promotion contracts are not supported");
  }
}

export function verifiedExpansionRunAuthority(
  capability: LongMemEvalExpansionCapability | undefined
): VerifiedExpansionRunAuthority | null {
  if (capability !== undefined) {
    throw new Error("expansion/promotion contracts are not supported");
  }
  return null;
}
