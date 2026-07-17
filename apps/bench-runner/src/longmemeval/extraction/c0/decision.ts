import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

export interface C0CacheCompatibilityIdentity {
  readonly datasetRevision: string;
  readonly model: string;
  readonly modelFamily: string;
  readonly requestProfile: string;
  readonly providerUrl: string;
  readonly systemPromptSha256: string;
  readonly cacheKeyAlgorithm: string;
  readonly rawClosureSha256: string;
  readonly parserSemanticsSha256: string;
  readonly formationSemanticsSha256: string;
  readonly temporalSchemaRevision: string;
}

export interface C0ReplayClosure {
  readonly occurrenceCount: number;
  readonly accountedOccurrences: number;
  readonly elementCount: number;
  readonly accountedElements: number;
  readonly admitted: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly invalid: number;
  readonly ledgerSha256: string;
}

export type C0ReuseReason =
  | "dataset_revision_mismatch"
  | "model_mismatch"
  | "model_family_mismatch"
  | "request_profile_mismatch"
  | "provider_url_mismatch"
  | "system_prompt_mismatch"
  | "cache_key_algorithm_mismatch"
  | "raw_closure_mismatch"
  | "parser_semantics_mismatch"
  | "formation_semantics_mismatch"
  | "temporal_schema_mismatch"
  | "replay_not_closed";

export interface C0ReuseDecision {
  readonly action: "reuse" | "rebuild";
  readonly sourceRoot: string;
  readonly reasons: readonly C0ReuseReason[];
  readonly source: C0CacheCompatibilityIdentity;
  readonly final: C0CacheCompatibilityIdentity;
  readonly replay: C0ReplayClosure;
}

export function decideC0Reuse(input: {
  readonly sourceRoot: string;
  readonly source: C0CacheCompatibilityIdentity;
  readonly final: C0CacheCompatibilityIdentity;
  readonly replay: C0ReplayClosure;
}): C0ReuseDecision {
  const reasons = [
    ...identityDifferences(input.source, input.final),
    ...(isReplayClosed(input.replay) ? [] : ["replay_not_closed" as const])
  ];
  return Object.freeze({
    action: reasons.length === 0 ? "reuse" : "rebuild",
    sourceRoot: input.sourceRoot,
    reasons: Object.freeze(reasons),
    source: Object.freeze({ ...input.source }),
    final: Object.freeze({ ...input.final }),
    replay: Object.freeze({ ...input.replay })
  });
}

export function hashC0Decision(decision: C0ReuseDecision): string {
  return createHash("sha256").update(JSON.stringify({
    action: decision.action,
    source_root: decision.sourceRoot,
    reasons: decision.reasons,
    source: decision.source,
    final: decision.final,
    replay: decision.replay
  }), "utf8").digest("hex");
}

export function assertFreshC0RebuildRoot(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
}): void {
  const sourceRoot = resolve(input.sourceRoot);
  const targetRoot = resolve(input.targetRoot);
  if (sourceRoot === targetRoot) throw new Error("C0 rebuild target must differ from source root");
  if (existsSync(targetRoot)) throw new Error("C0 rebuild target must not exist before creation");
  const parent = resolve(targetRoot, "..");
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new Error("C0 rebuild target parent must not be a symlink");
  }
}

function identityDifferences(
  source: C0CacheCompatibilityIdentity,
  final: C0CacheCompatibilityIdentity
): readonly C0ReuseReason[] {
  return compatibilityFields.flatMap(({ field, reason }) =>
    source[field] === final[field] && isPresent(source[field]) ? [] : [reason]
  );
}

function isReplayClosed(replay: C0ReplayClosure): boolean {
  const terminalCount = replay.admitted + replay.deferred + replay.rejected + replay.invalid;
  return replay.occurrenceCount === replay.accountedOccurrences &&
    replay.elementCount === replay.accountedElements && terminalCount === replay.elementCount &&
    replay.invalid === 0 && /^[a-f0-9]{64}$/u.test(replay.ledgerSha256);
}

const compatibilityFields: readonly {
  readonly field: keyof C0CacheCompatibilityIdentity;
  readonly reason: C0ReuseReason;
}[] = [
  { field: "datasetRevision", reason: "dataset_revision_mismatch" },
  { field: "model", reason: "model_mismatch" },
  { field: "modelFamily", reason: "model_family_mismatch" },
  { field: "requestProfile", reason: "request_profile_mismatch" },
  { field: "providerUrl", reason: "provider_url_mismatch" },
  { field: "systemPromptSha256", reason: "system_prompt_mismatch" },
  { field: "cacheKeyAlgorithm", reason: "cache_key_algorithm_mismatch" },
  { field: "rawClosureSha256", reason: "raw_closure_mismatch" },
  { field: "parserSemanticsSha256", reason: "parser_semantics_mismatch" },
  { field: "formationSemanticsSha256", reason: "formation_semantics_mismatch" },
  { field: "temporalSchemaRevision", reason: "temporal_schema_mismatch" }
];

function isPresent(value: string): boolean {
  return value.trim().length > 0;
}
