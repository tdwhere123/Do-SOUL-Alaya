import { createHash } from "node:crypto";
import {
  OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
  OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
  OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION,
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";

const SEMANTIC_ARTIFACT_MATERIALIZER_SEMANTICS_VERSION =
  "official-api-semantic-artifact-materializer-v1";
const OFFLINE_REPLAY_GOVERNANCE_SEMANTICS_VERSION = "offline-semantic-fill-governance-v1";

export interface SemanticReplayIdentity {
  readonly systemPromptSha256: string;
  readonly parserSemanticsVersion: string;
  readonly projectionSemanticsVersion: string;
  readonly materializerSemanticsVersion: string;
  readonly governanceSemanticsVersion: string;
}

export interface VerifiedSemanticReplayAuthority {
  readonly kind: "verified-semantic-replay-authority";
}

const captures = new WeakMap<object, SemanticReplayIdentity>();
let currentAuthority: VerifiedSemanticReplayAuthority | undefined;

export function currentSemanticReplayAuthority(): VerifiedSemanticReplayAuthority {
  if (currentAuthority !== undefined) return currentAuthority;
  const handle = Object.freeze({ kind: "verified-semantic-replay-authority" as const });
  captures.set(handle, Object.freeze({
    systemPromptSha256: digest(OFFICIAL_API_SYSTEM_PROMPT),
    parserSemanticsVersion: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
    projectionSemanticsVersion: OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
    materializerSemanticsVersion: SEMANTIC_ARTIFACT_MATERIALIZER_SEMANTICS_VERSION,
    governanceSemanticsVersion: [
      OFFLINE_REPLAY_GOVERNANCE_SEMANTICS_VERSION,
      `request-v${OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION}`,
      `batch-v${OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION}`,
      `workset-v${OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION}`
    ].join("/")
  }));
  currentAuthority = handle;
  return handle;
}

export function currentReplayAuthorityForLegacyPrompt(input: {
  readonly expectedSystemPrompt: string;
  readonly authoritySystemPromptSha256: string;
}): VerifiedSemanticReplayAuthority {
  const current = unwrapSemanticReplayAuthority(currentSemanticReplayAuthority());
  if (input.expectedSystemPrompt !== OFFICIAL_API_SYSTEM_PROMPT ||
      digest(input.expectedSystemPrompt) !== input.authoritySystemPromptSha256 ||
      current.systemPromptSha256 !== input.authoritySystemPromptSha256) {
    throw new Error("legacy raw replay is unavailable under the current official prompt authority");
  }
  return currentSemanticReplayAuthority();
}

export function unwrapSemanticReplayAuthority(
  handle: VerifiedSemanticReplayAuthority
): SemanticReplayIdentity {
  const identity = captures.get(handle);
  if (identity === undefined) {
    throw new Error("semantic replay identity requires the actual execution adapter authority");
  }
  return identity;
}

export function semanticReplayIdentityDigest(identity: SemanticReplayIdentity): string {
  return digest(JSON.stringify(parseSemanticReplayIdentity(identity)));
}

export function parseSemanticReplayIdentity(value: unknown): SemanticReplayIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("semantic replay identity is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "governanceSemanticsVersion",
    "materializerSemanticsVersion",
    "parserSemanticsVersion",
    "projectionSemanticsVersion",
    "systemPromptSha256"
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expected) ||
      typeof record.systemPromptSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.systemPromptSha256)) {
    throw new Error("semantic replay identity is invalid");
  }
  for (const key of expected.slice(0, 4)) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      throw new Error("semantic replay identity is incomplete");
    }
  }
  return Object.freeze({
    systemPromptSha256: record.systemPromptSha256,
    parserSemanticsVersion: record.parserSemanticsVersion as string,
    projectionSemanticsVersion: record.projectionSemanticsVersion as string,
    materializerSemanticsVersion: record.materializerSemanticsVersion as string,
    governanceSemanticsVersion: record.governanceSemanticsVersion as string
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
