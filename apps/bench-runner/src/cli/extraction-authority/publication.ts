import {
  inspectExtractionAuthority,
  type ExtractionAuthorityInspection
} from "../../bench/extraction/authority/inspection.js";
import {
  writeExtractionAuthorityReceipt,
  writeExtractionAuthorityReceiptExclusive,
  type ExtractionAuthorityReceipt
} from "../../bench/extraction/authority/receipt.js";
import {
  assertExtractionTargetSelectionReceipt,
  type ExtractionTargetSelectionReceipt
} from "../../bench/extraction/authority/target-selection/receipt.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease
} from "../../bench/extraction/fill/manifest/fill-root-guard.js";
import {
  persistContinuationAuthority,
  type AuthorityContinuationDependencies,
  type PreparedAuthorityContinuation
} from "./continuation.js";

export interface AuthorityPublicationDependencies extends AuthorityContinuationDependencies {
  readonly inspect?: typeof inspectExtractionAuthority;
  readonly write?: typeof writeExtractionAuthorityReceipt;
  readonly writeExclusive?: typeof writeExtractionAuthorityReceiptExclusive;
  readonly assertTargetSelection?: typeof assertExtractionTargetSelectionReceipt;
}

function assertExactAuthorityIssuanceInspection(
  prepared: ExtractionAuthorityInspection,
  live: ExtractionAuthorityInspection
): void {
  if (JSON.stringify(prepared.observation) !== JSON.stringify(live.observation) ||
      JSON.stringify(prepared.missingKeys) !== JSON.stringify(live.missingKeys) ||
      JSON.stringify(prepared.invalidShards) !== JSON.stringify(live.invalidShards) ||
      JSON.stringify(prepared.preservedValidClosure) !==
        JSON.stringify(live.preservedValidClosure)) {
    throw new Error("extraction authority cache drifted during issuance");
  }
}

export interface PreparedAuthorityPublication {
  readonly cacheRoot: string;
  readonly outputPath: string;
  readonly inspection: ExtractionAuthorityInspection;
  readonly inspectionInput: Parameters<typeof inspectExtractionAuthority>[0];
  readonly receipt: ExtractionAuthorityReceipt;
  readonly targetSelection: ExtractionTargetSelectionReceipt | undefined;
  readonly continuation?: PreparedAuthorityContinuation;
}

export async function publishAuthorizedExtractionReceipt(
  input: PreparedAuthorityPublication,
  deps: AuthorityPublicationDependencies
): Promise<void> {
  if (input.continuation !== undefined) {
    await publishContinuation(input, deps);
    return;
  }
  (deps.write ?? writeExtractionAuthorityReceipt)(input.outputPath, input.receipt);
}

async function publishContinuation(
  input: PreparedAuthorityPublication,
  deps: AuthorityPublicationDependencies
): Promise<void> {
  const lease = acquireExtractionCacheWriteLease(input.cacheRoot);
  await withExtractionCacheWriteLease(lease, async () => {
    const live = await (deps.inspect ?? inspectExtractionAuthority)(input.inspectionInput);
    assertExactAuthorityIssuanceInspection(input.inspection, live);
    persistContinuationAuthority({
      cacheRoot: input.cacheRoot,
      outputPath: input.outputPath,
      receipt: input.receipt,
      prepared: input.continuation!,
      dependencies: deps
    });
  });
}
