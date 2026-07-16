import type { LongMemEvalSelectionContractIdentity } from
  "../selection/contract.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import {
  verifiedExpansionRunAuthority
} from "../promotion/expansion-run-authority.js";
import {
  compactSnapshotRunProvenance
} from "../snapshot/run-provenance.js";
import {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_REF_FILENAME,
  buildShardExtractionAuthorityReference,
  renderShardExtractionAuthorityReference
} from "./extraction-authority-reference.js";
import {
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
  buildLongMemEvalRunProvenance,
  renderLongMemEvalRunProvenance,
  type LongMemEvalRunProvenance
} from "./run.js";

export interface ArchiveRunProvenanceBundle {
  readonly full: LongMemEvalRunProvenance;
  readonly fullContents: string;
  readonly sidecar: { readonly filename: string; readonly contents: string };
  readonly authorityReferenceSidecar: {
    readonly filename: string;
    readonly contents: string;
  } | null;
}

export async function buildArchiveRunProvenanceBundle(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly evaluatedCount: number;
  readonly commitSha7: string;
  readonly embeddingProviderLabel: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly datasetSha256: string;
  readonly selection: LongMemEvalSelectionContractIdentity;
}): Promise<ArchiveRunProvenanceBundle> {
  const full = await buildLongMemEvalRunProvenance(input);
  const fullContents = renderLongMemEvalRunProvenance(full);
  const expansion = verifiedExpansionRunAuthority(
    input.opts.expansionCapability
  );
  if (expansion === null || expansion.fanoutChild === null) {
    return {
      full,
      fullContents,
      sidecar: {
        filename: LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
        contents: fullContents
      },
      authorityReferenceSidecar: null
    };
  }
  const compact = compactSnapshotRunProvenance(full);
  const reference = buildShardExtractionAuthorityReference({
    compact,
    captured: expansion.extraction,
    fanoutChild: expansion.fanoutChild
  });
  return {
    full,
    fullContents,
    sidecar: {
      filename: LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
      contents: `${JSON.stringify(compact, null, 2)}\n`
    },
    authorityReferenceSidecar: {
      filename: LONGMEMEVAL_EXTRACTION_AUTHORITY_REF_FILENAME,
      contents: renderShardExtractionAuthorityReference(reference)
    }
  };
}
