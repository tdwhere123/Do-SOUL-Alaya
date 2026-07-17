import {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
  LONGMEMEVAL_EXTRACTION_AUTHORITY_REF_FILENAME,
  LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME,
  LongMemEvalFanoutAuthoritySchema,
  LongMemEvalShardAuthorityReferenceSchema,
  assertLongMemEvalFanoutAuthorityBinding,
  assertLongMemEvalFanoutReferenceBinding,
  canonicalJson,
  longMemEvalArtifactDescriptor,
  type LongMemEvalArtifactDescriptor,
  type LongMemEvalFanoutAuthority,
  type LongMemEvalShardAuthorityReference
} from "@do-soul/alaya-eval/internal";
import { openContainedArtifact } from "../../../cli/merge/contained-artifact-path.js";
import type { VerifiedLongMemEvalFanoutChild } from
  "../../promotion/fanout-authority.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  parseSnapshotExtractionAuthorityBytes,
  type CapturedSnapshotExtractionAuthority,
  type SnapshotExtractionAuthority
} from "../../snapshot/extraction-authority.js";
import {
  LongMemEvalSnapshotRunProvenanceSchema,
  bindSnapshotRunProvenanceAuthority,
  type LongMemEvalSnapshotRunProvenance
} from "../../snapshot/run-provenance.js";
import type { LongMemEvalRunProvenance } from "../run.js";

export {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
  LONGMEMEVAL_EXTRACTION_AUTHORITY_REF_FILENAME
};
export type ShardExtractionAuthorityReference = LongMemEvalShardAuthorityReference;

interface LoadedGlobalFanoutAuthority {
  readonly descriptor: LongMemEvalArtifactDescriptor;
  readonly authority: LongMemEvalFanoutAuthority;
  readonly contents: string;
}

export interface LoadedGlobalExtractionAuthority {
  readonly descriptor: LongMemEvalArtifactDescriptor;
  readonly authority: SnapshotExtractionAuthority;
  readonly contents: string;
  readonly fanout: LoadedGlobalFanoutAuthority | null;
}

export function buildShardExtractionAuthorityReference(input: {
  readonly compact: LongMemEvalSnapshotRunProvenance;
  readonly captured: CapturedSnapshotExtractionAuthority;
  readonly fanoutChild: VerifiedLongMemEvalFanoutChild;
}): ShardExtractionAuthorityReference {
  const cache = requireCurrentCompactCache(input.compact);
  assertSnapshotExtractionAuthorityBinding(input.captured.authority, cache);
  const authority = longMemEvalArtifactDescriptor(
    LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
    input.captured.bytes
  );
  const reference = LongMemEvalShardAuthorityReferenceSchema.parse({
    schema_version: 2,
    kind: "longmemeval_extraction_authority_ref",
    authority,
    fanout: {
      ...input.fanoutChild.descriptor,
      run_nonce: input.fanoutChild.authority.run_nonce
    },
    plan: input.fanoutChild.plan,
    source_manifest_sha256: input.captured.authority.source_manifest_sha256
  });
  assertLongMemEvalFanoutReferenceBinding({
    reference,
    fanout: input.fanoutChild.authority,
    fanoutDescriptor: input.fanoutChild.descriptor,
    extractionDescriptor: authority,
    sourceManifestSha256: input.captured.authority.source_manifest_sha256
  });
  return reference;
}

export function renderShardExtractionAuthorityReference(
  reference: ShardExtractionAuthorityReference
): string {
  return `${JSON.stringify(LongMemEvalShardAuthorityReferenceSchema.parse(reference))}\n`;
}

export function parseShardExtractionAuthorityReference(
  contents: string,
  label: string
): ShardExtractionAuthorityReference {
  try {
    return LongMemEvalShardAuthorityReferenceSchema.parse(JSON.parse(contents));
  } catch (cause) {
    throw new Error(`invalid shard extraction authority reference at ${label}`, {
      cause
    });
  }
}

export async function loadGlobalExtractionAuthority(
  root: string,
  hooks: { readonly afterSnapshot?: () => void | Promise<void> } = {}
): Promise<LoadedGlobalExtractionAuthority | null> {
  const file = await openContainedArtifact(
    root,
    LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME
  );
  if (file === null) return null;
  try {
    const bytes = await file.readBytes(MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES);
    await hooks.afterSnapshot?.();
    const authority = parseSnapshotExtractionAuthorityBytes(
      bytes,
      LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME
    );
    return Object.freeze({
      descriptor: longMemEvalArtifactDescriptor(
        LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
        bytes
      ),
      authority,
      contents: Buffer.from(bytes).toString("utf8"),
      fanout: await loadGlobalFanoutAuthority(root)
    });
  } finally {
    await file.close();
  }
}

export function bindShardRunProvenanceAuthority(input: {
  readonly compact: LongMemEvalSnapshotRunProvenance;
  readonly reference: ShardExtractionAuthorityReference;
  readonly global: LoadedGlobalExtractionAuthority;
}): LongMemEvalRunProvenance {
  const compact = LongMemEvalSnapshotRunProvenanceSchema.parse(input.compact);
  const cache = requireCurrentCompactCache(compact);
  const fanout = input.global.fanout;
  if (fanout === null) {
    throw new Error("compact shard provenance requires parent fanout authority");
  }
  assertLongMemEvalFanoutAuthorityBinding({
    fanout: fanout.authority,
    authority: input.global.authority,
    compact: cache,
    extractionDescriptor: input.global.descriptor
  });
  assertLongMemEvalFanoutReferenceBinding({
    reference: input.reference,
    fanout: fanout.authority,
    fanoutDescriptor: fanout.descriptor,
    extractionDescriptor: input.global.descriptor,
    sourceManifestSha256: input.global.authority.source_manifest_sha256
  });
  assertShardInvocationBinding(compact, input.reference, fanout.authority);
  assertSnapshotExtractionAuthorityBinding(input.global.authority, cache);
  return bindSnapshotRunProvenanceAuthority(compact, input.global.authority);
}

function assertShardInvocationBinding(
  compact: LongMemEvalSnapshotRunProvenance,
  reference: ShardExtractionAuthorityReference,
  fanout: LongMemEvalFanoutAuthority
): void {
  const code = compact.code;
  if (compact.execution.offset !== reference.plan.offset ||
      compact.execution.limit !== reference.plan.limit ||
      compact.execution.evaluated_count !== reference.plan.limit ||
      code.commit_sha !== fanout.code.commit_sha ||
      code.worktree_state_sha256 !== fanout.code.worktree_state_sha256 ||
      code.gate_sha256 !== fanout.promotion.contract_sha256 ||
      canonicalJson(code.executed_dist) !== canonicalJson(fanout.code.executed_dist)) {
    throw new Error("compact shard invocation differs from parent fanout authority");
  }
}

async function loadGlobalFanoutAuthority(
  root: string
): Promise<LoadedGlobalFanoutAuthority | null> {
  const file = await openContainedArtifact(root, LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME);
  if (file === null) return null;
  try {
    const bytes = await file.readBytes(1024 * 1024);
    return Object.freeze({
      descriptor: longMemEvalArtifactDescriptor(
        LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME,
        bytes
      ),
      authority: LongMemEvalFanoutAuthoritySchema.parse(parseJson(bytes)),
      contents: Buffer.from(bytes).toString("utf8")
    });
  } finally {
    await file.close();
  }
}

function requireCurrentCompactCache(
  provenance: LongMemEvalSnapshotRunProvenance
) {
  const cache = provenance.extraction_cache;
  if (cache?.schema_version !== 3) {
    throw new Error("shard run provenance has no current extraction summary");
  }
  return cache;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error("invalid LongMemEval fanout authority JSON", { cause });
  }
}
