import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

export interface RawExtractionCacheIdentity {
  readonly datasetRevision: string;
  readonly model: string;
  readonly requestProfile: string;
  readonly providerUrl: string;
  readonly systemPromptSha256: string;
  readonly cacheKeyAlgorithm: string;
  readonly rawClosureSha256: string;
}

export interface ExtractionProjectionIdentity {
  readonly modelFamily: string;
  readonly parserSemanticsSha256: string;
  readonly formationSemanticsSha256: string;
  readonly temporalSchemaRevision: string;
}

export interface ExtractionCacheCompatibilityIdentity {
  readonly raw: RawExtractionCacheIdentity;
  readonly projection: ExtractionProjectionIdentity;
}

export interface ExtractionReplayClosure {
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

export type RawExtractionCacheCompatibilityReason =
  | "dataset_revision_mismatch"
  | "model_mismatch"
  | "request_profile_mismatch"
  | "provider_url_mismatch"
  | "system_prompt_mismatch"
  | "cache_key_algorithm_mismatch"
  | "raw_closure_mismatch"
  | "raw_inventory_not_closed";

export type ExtractionProjectionCompatibilityReason =
  | "model_family_mismatch"
  | "parser_semantics_mismatch"
  | "formation_semantics_mismatch"
  | "temporal_schema_mismatch"
  | "raw_cache_rebuild"
  | "replay_not_closed";

export interface RawExtractionCacheDecision {
  readonly action: "reuse" | "rebuild";
  readonly reasons: readonly RawExtractionCacheCompatibilityReason[];
  readonly source: RawExtractionCacheIdentity;
  readonly final: RawExtractionCacheIdentity;
}

export interface ExtractionProjectionDecision {
  readonly action: "reuse" | "replay" | "blocked";
  readonly reasons: readonly ExtractionProjectionCompatibilityReason[];
  readonly source: ExtractionProjectionIdentity;
  readonly final: ExtractionProjectionIdentity;
  readonly replay: ExtractionReplayClosure;
}

export interface ExtractionCacheCompatibilityDecision {
  readonly sourceRoot: string;
  readonly raw: RawExtractionCacheDecision;
  readonly projection: ExtractionProjectionDecision;
}

export function decideExtractionCacheCompatibility(input: {
  readonly sourceRoot: string;
  readonly source: ExtractionCacheCompatibilityIdentity;
  readonly final: ExtractionCacheCompatibilityIdentity;
  readonly replay: ExtractionReplayClosure;
  readonly rawInventoryClosed?: boolean;
}): ExtractionCacheCompatibilityDecision {
  const rawReasons = rawIdentityDifferences(input.source.raw, input.final.raw);
  if (input.rawInventoryClosed === false) rawReasons.push("raw_inventory_not_closed");
  const rawAction = rawReasons.length === 0 ? "reuse" as const : "rebuild" as const;
  const semanticReasons = projectionIdentityDifferences(
    input.source.projection,
    input.final.projection
  );
  const replayClosed = isReplayClosed(input.replay);
  const projectionReasons: ExtractionProjectionCompatibilityReason[] = [
    ...semanticReasons,
    ...(rawAction === "rebuild" ? ["raw_cache_rebuild" as const] : []),
    ...(replayClosed ? [] : ["replay_not_closed" as const])
  ];
  const projectionAction = !replayClosed
    ? "blocked" as const
    : projectionReasons.length === 0 ? "reuse" as const : "replay" as const;
  return Object.freeze({
    sourceRoot: input.sourceRoot,
    raw: freezeDecision(rawAction, rawReasons, input.source.raw, input.final.raw),
    projection: Object.freeze({
      action: projectionAction,
      reasons: Object.freeze(projectionReasons),
      source: Object.freeze({ ...input.source.projection }),
      final: Object.freeze({ ...input.final.projection }),
      replay: Object.freeze({ ...input.replay })
    })
  });
}

function freezeDecision(
  action: RawExtractionCacheDecision["action"],
  reasons: readonly RawExtractionCacheCompatibilityReason[],
  source: RawExtractionCacheIdentity,
  final: RawExtractionCacheIdentity
): RawExtractionCacheDecision {
  return Object.freeze({
    action,
    reasons: Object.freeze(reasons),
    source: Object.freeze({ ...source }),
    final: Object.freeze({ ...final })
  });
}

export function hashExtractionCacheCompatibilityDecision(
  decision: ExtractionCacheCompatibilityDecision
): string {
  return createHash("sha256").update(JSON.stringify(decision), "utf8").digest("hex");
}

export function assertFreshExtractionCacheRoot(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
}): void {
  const sourceRoot = resolve(input.sourceRoot);
  const targetRoot = resolve(input.targetRoot);
  if (sourceRoot === targetRoot) {
    throw new Error("extraction cache rebuild target must differ from source root");
  }
  if (existsSync(targetRoot)) {
    throw new Error("extraction cache rebuild target must not exist before creation");
  }
  const parent = resolve(targetRoot, "..");
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new Error("extraction cache rebuild target parent must not be a symlink");
  }
}

function rawIdentityDifferences(
  source: RawExtractionCacheIdentity,
  final: RawExtractionCacheIdentity
): RawExtractionCacheCompatibilityReason[] {
  return rawCompatibilityFields.flatMap(({ field, reason }) =>
    source[field] === final[field] && isPresent(source[field]) ? [] : [reason]
  );
}

function projectionIdentityDifferences(
  source: ExtractionProjectionIdentity,
  final: ExtractionProjectionIdentity
): ExtractionProjectionCompatibilityReason[] {
  return projectionCompatibilityFields.flatMap(({ field, reason }) =>
    source[field] === final[field] && isPresent(source[field]) ? [] : [reason]
  );
}

function isReplayClosed(replay: ExtractionReplayClosure): boolean {
  const terminalCount = replay.admitted + replay.deferred + replay.rejected + replay.invalid;
  return replay.occurrenceCount === replay.accountedOccurrences &&
    replay.elementCount === replay.accountedElements && terminalCount === replay.elementCount &&
    replay.invalid === 0 && /^[a-f0-9]{64}$/u.test(replay.ledgerSha256);
}

const rawCompatibilityFields: readonly {
  readonly field: keyof RawExtractionCacheIdentity;
  readonly reason: RawExtractionCacheCompatibilityReason;
}[] = [
  { field: "datasetRevision", reason: "dataset_revision_mismatch" },
  { field: "model", reason: "model_mismatch" },
  { field: "requestProfile", reason: "request_profile_mismatch" },
  { field: "providerUrl", reason: "provider_url_mismatch" },
  { field: "systemPromptSha256", reason: "system_prompt_mismatch" },
  { field: "cacheKeyAlgorithm", reason: "cache_key_algorithm_mismatch" },
  { field: "rawClosureSha256", reason: "raw_closure_mismatch" }
];

const projectionCompatibilityFields: readonly {
  readonly field: keyof ExtractionProjectionIdentity;
  readonly reason: ExtractionProjectionCompatibilityReason;
}[] = [
  { field: "modelFamily", reason: "model_family_mismatch" },
  { field: "parserSemanticsSha256", reason: "parser_semantics_mismatch" },
  { field: "formationSemanticsSha256", reason: "formation_semantics_mismatch" },
  { field: "temporalSchemaRevision", reason: "temporal_schema_mismatch" }
];

function isPresent(value: string): boolean {
  return value.trim().length > 0;
}
