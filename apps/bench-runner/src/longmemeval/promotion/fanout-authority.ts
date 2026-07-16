import { randomUUID } from "node:crypto";
import {
  LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME,
  LongMemEvalFanoutAuthoritySchema,
  assertLongMemEvalFanoutAuthorityBinding,
  longMemEvalArtifactDescriptor,
  renderLongMemEvalAuthorityWire,
  type LongMemEvalArtifactDescriptor,
  type LongMemEvalFanoutAuthority,
  type LongMemEvalFanoutPlan
} from "@do-soul/alaya-eval/internal";
import { openContainedArtifact } from "../../cli/merge/contained-artifact-path.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import type { CapturedSnapshotExtractionAuthority } from
  "../snapshot/extraction-authority.js";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "./expansion-capability.js";

export const ALAYA_LONGMEMEVAL_FANOUT_ROOT = "ALAYA_LONGMEMEVAL_FANOUT_ROOT";
export const ALAYA_LONGMEMEVAL_FANOUT_SHA256 = "ALAYA_LONGMEMEVAL_FANOUT_SHA256";
export const ALAYA_LONGMEMEVAL_FANOUT_SHARD_INDEX =
  "ALAYA_LONGMEMEVAL_FANOUT_SHARD_INDEX";
const MAX_FANOUT_AUTHORITY_BYTES = 1024 * 1024;

export interface BuiltLongMemEvalFanoutAuthority {
  readonly authority: LongMemEvalFanoutAuthority;
  readonly descriptor: LongMemEvalArtifactDescriptor;
  readonly bytes: Buffer;
}

export interface VerifiedLongMemEvalFanoutChild {
  readonly authority: LongMemEvalFanoutAuthority;
  readonly descriptor: LongMemEvalArtifactDescriptor;
  readonly plan: LongMemEvalFanoutPlan;
}

export function buildLongMemEvalFanoutAuthority(input: {
  readonly capability: LongMemEvalExpansionCapability;
  readonly extraction: CapturedSnapshotExtractionAuthority;
  readonly requestedConcurrency: number;
  readonly plans: readonly LongMemEvalFanoutPlan[];
}): BuiltLongMemEvalFanoutAuthority {
  const data = longMemEvalExpansionCapabilityData(input.capability);
  const extractionDescriptor = longMemEvalArtifactDescriptor(
    "longmemeval-extraction-authority.json",
    input.extraction.bytes
  );
  const authority = LongMemEvalFanoutAuthoritySchema.parse({
    schema_version: 1,
    kind: "longmemeval_parent_fanout_authority",
    run_nonce: randomUUID(),
    promotion: promotionIdentity(data),
    dataset: { variant: "longmemeval_s", sha256: data.nextSelection.dataset_sha256 },
    cache: cacheIdentity(input.extraction, extractionDescriptor),
    code: data.code,
    requested_concurrency: input.requestedConcurrency,
    effective_concurrency: input.plans.length,
    plans: input.plans
  });
  assertLongMemEvalFanoutAuthorityBinding({
    fanout: authority,
    authority: input.extraction.authority,
    compact: input.extraction.compact,
    extractionDescriptor
  });
  const bytes = Buffer.from(renderLongMemEvalAuthorityWire(authority), "utf8");
  return {
    authority,
    bytes,
    descriptor: longMemEvalArtifactDescriptor(
      LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME,
      bytes
    )
  };
}

export async function verifyLongMemEvalFanoutChild(input: {
  readonly capability: LongMemEvalExpansionCapability;
  readonly extraction: CapturedSnapshotExtractionAuthority;
  readonly options: LongMemEvalRunOptions;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<VerifiedLongMemEvalFanoutChild | null> {
  const context = readFanoutChildContext(input.env);
  if (context === null) return null;
  const opened = await openContainedArtifact(
    context.root,
    LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME
  );
  if (opened === null) throw new Error("500Q fanout authority artifact is missing");
  try {
    const bytes = await opened.readBytes(MAX_FANOUT_AUTHORITY_BYTES);
    const descriptor = longMemEvalArtifactDescriptor(
      LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME,
      bytes
    );
    if (descriptor.sha256 !== context.sha256) {
      throw new Error("500Q fanout authority differs from private child context");
    }
    const authority = LongMemEvalFanoutAuthoritySchema.parse(parseJson(bytes));
    assertChildBinding(input, authority, descriptor, context.shardIndex);
    return { authority, descriptor, plan: authority.plans[context.shardIndex]! };
  } finally {
    await opened.close();
  }
}

export function longMemEvalFanoutChildEnv(input: {
  readonly root: string;
  readonly descriptor: LongMemEvalArtifactDescriptor;
  readonly shardIndex: number;
}): NodeJS.ProcessEnv {
  return {
    [ALAYA_LONGMEMEVAL_FANOUT_ROOT]: input.root,
    [ALAYA_LONGMEMEVAL_FANOUT_SHA256]: input.descriptor.sha256,
    [ALAYA_LONGMEMEVAL_FANOUT_SHARD_INDEX]: String(input.shardIndex)
  };
}

function assertChildBinding(
  input: Parameters<typeof verifyLongMemEvalFanoutChild>[0],
  authority: LongMemEvalFanoutAuthority,
  descriptor: LongMemEvalArtifactDescriptor,
  shardIndex: number
): void {
  const plan = authority.plans[shardIndex];
  assertLongMemEvalFanoutAuthorityBinding({
    fanout: authority,
    authority: input.extraction.authority,
    compact: input.extraction.compact,
    extractionDescriptor: longMemEvalArtifactDescriptor(
      "longmemeval-extraction-authority.json",
      input.extraction.bytes
    )
  });
  const data = longMemEvalExpansionCapabilityData(input.capability);
  if (plan === undefined || (input.options.concurrency ?? 1) !== 1 ||
      (input.options.offset ?? 0) !== plan.offset || input.options.limit !== plan.limit ||
      descriptor.path !== LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME ||
      JSON.stringify(authority.promotion) !== JSON.stringify(promotionIdentity(data))) {
    throw new Error("500Q worker invocation differs from its parent fanout plan");
  }
}

function readFanoutChildContext(
  env: Readonly<Record<string, string | undefined>>
): { readonly root: string; readonly sha256: string; readonly shardIndex: number } | null {
  const values = [
    env[ALAYA_LONGMEMEVAL_FANOUT_ROOT],
    env[ALAYA_LONGMEMEVAL_FANOUT_SHA256],
    env[ALAYA_LONGMEMEVAL_FANOUT_SHARD_INDEX]
  ];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined)) {
    throw new Error("500Q private fanout child context is incomplete");
  }
  const [root, sha256, shard] = values as [string, string, string];
  const shardIndex = Number(shard);
  if (root.trim().length === 0 || !/^[a-f0-9]{64}$/u.test(sha256) ||
      !Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex > 31) {
    throw new Error("500Q private fanout child context is invalid");
  }
  return { root, sha256, shardIndex };
}

function promotionIdentity(
  data: ReturnType<typeof longMemEvalExpansionCapabilityData>
) {
  return {
    contract_sha256: data.contractSha256,
    policy_version: data.policyVersion,
    code: data.code,
    source_selection: data.sourceSelection,
    next_selection: data.nextSelection,
    matrix_sha256: data.matrix.sha256,
    product_default: data.productDefault
  };
}

function cacheIdentity(
  extraction: CapturedSnapshotExtractionAuthority,
  descriptor: LongMemEvalArtifactDescriptor
) {
  const authority = extraction.authority;
  if (authority.expansion_source_anchor_sha256 === undefined ||
      authority.expansion_lineage_sha256 === undefined) {
    throw new Error("500Q fanout requires expansion anchor and lineage digests");
  }
  return {
    extraction_authority: descriptor,
    source_manifest_sha256: authority.source_manifest_sha256,
    content_closure_sha256: authority.content_closure_sha256,
    expansion_source_anchor_sha256: authority.expansion_source_anchor_sha256,
    expansion_lineage_sha256: authority.expansion_lineage_sha256
  };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error("500Q fanout authority is not valid UTF-8 JSON", { cause });
  }
}
