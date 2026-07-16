import {
  assertLongMemEvalFullExtractionClosure
} from "@do-soul/alaya-eval/internal";
import {
  bindShardRunProvenanceAuthority,
  parseShardExtractionAuthorityReference,
  type LoadedGlobalExtractionAuthority,
  type ShardExtractionAuthorityReference
} from "../../longmemeval/provenance/extraction-authority-reference.js";
import {
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../longmemeval/provenance/run.js";
import {
  LongMemEvalSnapshotRunProvenanceSchema,
  type LongMemEvalSnapshotRunProvenance
} from "../../longmemeval/snapshot/run-provenance.js";
import { assertProductDefaultRunProvenancePolicy } from
  "../../longmemeval/promotion/product-policy-verifier.js";

export type ShardArchivedRunProvenance =
  | LongMemEvalRunProvenance
  | LongMemEvalSnapshotRunProvenance;

export interface VerifiedShardRunProvenance {
  readonly archived: ShardArchivedRunProvenance;
  readonly hydrated: LongMemEvalRunProvenance;
  readonly reference: ShardExtractionAuthorityReference | null;
  readonly referenceContents: string | null;
}

export function verifyShardRunProvenance(input: {
  readonly provenanceContents: string;
  readonly referenceContents: string | null;
  readonly globalAuthority: LoadedGlobalExtractionAuthority | null;
}): VerifiedShardRunProvenance {
  const raw = parseJson(input.provenanceContents, "shard run provenance");
  if (input.referenceContents === null) {
    const full = LongMemEvalRunProvenanceSchema.parse(raw);
    assertLongMemEvalFullExtractionClosure(full.extraction_cache);
    assertGateEligible(full);
    return {
      archived: full,
      hydrated: full,
      reference: null,
      referenceContents: null
    };
  }
  if (input.globalAuthority === null) {
    throw new Error("merge refused: compact shard has no global extraction authority");
  }
  const compact = LongMemEvalSnapshotRunProvenanceSchema.parse(raw);
  const reference = parseShardExtractionAuthorityReference(
    input.referenceContents,
    "shard evidence"
  );
  const hydrated = bindShardRunProvenanceAuthority({
    compact,
    reference,
    global: input.globalAuthority
  });
  assertLongMemEvalFullExtractionClosure(hydrated.extraction_cache);
  assertFanoutProductPolicy(hydrated);
  assertGateEligible(hydrated);
  return {
    archived: compact,
    hydrated,
    reference,
    referenceContents: input.referenceContents
  };
}

function assertFanoutProductPolicy(provenance: LongMemEvalRunProvenance): void {
  assertProductDefaultRunProvenancePolicy(
    provenance,
    "merge compact shard product-default"
  );
  if (provenance.question_manifest !== null) {
    throw new Error("merge refused: compact shard uses a selection manifest");
  }
}

function assertGateEligible(provenance: LongMemEvalRunProvenance): void {
  if (!isLongMemEvalRunProvenanceGateEligible(provenance)) {
    throw new Error("merge refused: shard evidence provenance binding mismatch");
  }
}

function parseJson(contents: string, label: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (cause) {
    throw new Error(`merge refused: invalid ${label}`, { cause });
  }
}
