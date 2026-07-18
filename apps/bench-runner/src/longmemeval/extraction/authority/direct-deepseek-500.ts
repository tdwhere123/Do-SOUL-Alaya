import type { ExtractionAuthorityObservation } from "./receipt.js";
import {
  assertExtractionTargetRootBinding,
  createFreshExtractionTargetRoot,
  discardFreshExtractionTargetRoot,
  type ExtractionTargetRootBinding
} from "./target-root-binding.js";
import type { ExtractionCacheWriteLease } from "../fill/manifest/fill-root-guard.js";

export const DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE = 30;
const DIRECT_DEEPSEEK_500_MODEL_FAMILY = "deepseek-v4-flash-nonthinking";
const DIRECT_DEEPSEEK_500_REQUEST_PROFILE = "deepseek-v4-nonthinking-v1";
const directRootMarker = {
  filename: ".alaya-direct-deepseek-500-root.json",
  kind: "alaya_direct_deepseek_500_root"
} as const;
const NEW_API_DEEPSEEK_500_MODEL = "DeepSeek-V4-Flash";
const newApiRootMarker = {
  filename: ".alaya-direct-newapi-deepseek-500-root.json",
  kind: "alaya_direct_newapi_deepseek_500_root"
} as const;

export interface DirectDeepSeek500SpendAuthorization extends ExtractionTargetRootBinding {
  readonly kind: "deepseek_direct_500";
  readonly operator: string;
  readonly requests_per_minute: typeof DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE;
}

export interface NewApiDeepSeek500SpendAuthorization extends ExtractionTargetRootBinding {
  readonly kind: "deepseek_newapi_direct_500";
  readonly operator: string;
}

export type DirectExtractionSpendAuthorization =
  | DirectDeepSeek500SpendAuthorization
  | NewApiDeepSeek500SpendAuthorization;

export function createFreshDirectDeepSeek500Authorization(input: {
  readonly cacheRoot: string;
  readonly operator: string;
}): DirectDeepSeek500SpendAuthorization {
  const operator = requireOperator(input.operator);
  return Object.freeze({
    kind: "deepseek_direct_500",
    operator,
    requests_per_minute: DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE,
    ...createFreshExtractionTargetRoot({
      cacheRoot: input.cacheRoot,
      marker: directRootMarker,
      purpose: "direct DeepSeek 500"
    })
  });
}

export function createFreshNewApiDeepSeek500Authorization(input: {
  readonly cacheRoot: string;
  readonly operator: string;
}): NewApiDeepSeek500SpendAuthorization {
  const operator = requireOperator(input.operator);
  return Object.freeze({
    kind: "deepseek_newapi_direct_500",
    operator,
    ...createFreshExtractionTargetRoot({
      cacheRoot: input.cacheRoot,
      marker: newApiRootMarker,
      purpose: "direct NewAPI DeepSeek 500"
    })
  });
}

export function assertDirectDeepSeek500Authorization(input: {
  readonly action: "probe" | "fill";
  readonly authorization: DirectDeepSeek500SpendAuthorization;
  readonly observation: ExtractionAuthorityObservation;
}): void {
  const authorization = input.authorization;
  if (authorization.kind !== "deepseek_direct_500" || !hasValidRootBinding(authorization) ||
      authorization.requests_per_minute !== DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE) {
    throw new Error("direct DeepSeek 500 authorization is invalid");
  }
  if (input.action !== "fill" || !isFreshNonthinkingDeepSeek500Observation(
    input.observation, "deepseek-v4-flash"
  )) {
    throw new Error("direct DeepSeek 500 authorization has the wrong extraction scope");
  }
}

export function assertNewApiDeepSeek500Authorization(input: {
  readonly action: "probe" | "fill";
  readonly authorization: NewApiDeepSeek500SpendAuthorization;
  readonly observation: ExtractionAuthorityObservation;
}): void {
  const authorization = input.authorization;
  if (authorization.kind !== "deepseek_newapi_direct_500" || !hasValidRootBinding(authorization)) {
    throw new Error("direct NewAPI DeepSeek 500 authorization is invalid");
  }
  if (input.action !== "fill" || !isFreshNonthinkingDeepSeek500Observation(
    input.observation, NEW_API_DEEPSEEK_500_MODEL
  )) {
    throw new Error("direct NewAPI DeepSeek 500 authorization has the wrong extraction scope");
  }
}

export function assertDirectExtractionSpendAuthorization(input: {
  readonly action: "probe" | "fill";
  readonly authorization: DirectExtractionSpendAuthorization;
  readonly observation: ExtractionAuthorityObservation;
}): void {
  if (isDirectDeepSeek500Authorization(input.authorization)) {
    assertDirectDeepSeek500Authorization({
      action: input.action,
      authorization: input.authorization,
      observation: input.observation
    });
    return;
  }
  if (isNewApiDeepSeek500Authorization(input.authorization)) {
    assertNewApiDeepSeek500Authorization({
      action: input.action,
      authorization: input.authorization,
      observation: input.observation
    });
    return;
  }
  throw new Error("direct extraction authorization is invalid");
}

export function assertDirectDeepSeek500RootBinding(input: {
  readonly authorization: DirectDeepSeek500SpendAuthorization;
  readonly cacheRoot: string;
  readonly writeLease?: ExtractionCacheWriteLease;
}): void {
  assertExtractionTargetRootBinding({
    cacheRoot: input.cacheRoot,
    marker: directRootMarker,
    purpose: "direct DeepSeek 500 authorization",
    binding: input.authorization,
    ...(input.writeLease === undefined ? {} : { writeLease: input.writeLease })
  });
}

export function assertNewApiDeepSeek500RootBinding(input: {
  readonly authorization: NewApiDeepSeek500SpendAuthorization;
  readonly cacheRoot: string;
  readonly writeLease?: ExtractionCacheWriteLease;
}): void {
  assertExtractionTargetRootBinding({
    cacheRoot: input.cacheRoot,
    marker: newApiRootMarker,
    purpose: "direct NewAPI DeepSeek 500 authorization",
    binding: input.authorization,
    ...(input.writeLease === undefined ? {} : { writeLease: input.writeLease })
  });
}

export function assertDirectExtractionSpendRootBinding(input: {
  readonly authorization: DirectExtractionSpendAuthorization;
  readonly cacheRoot: string;
  readonly writeLease?: ExtractionCacheWriteLease;
}): void {
  if (isDirectDeepSeek500Authorization(input.authorization)) {
    assertDirectDeepSeek500RootBinding({
      authorization: input.authorization,
      cacheRoot: input.cacheRoot,
      ...(input.writeLease === undefined ? {} : { writeLease: input.writeLease })
    });
    return;
  }
  assertNewApiDeepSeek500RootBinding({
    authorization: input.authorization,
    cacheRoot: input.cacheRoot,
    ...(input.writeLease === undefined ? {} : { writeLease: input.writeLease })
  });
}

export function discardFreshDirectDeepSeek500Authorization(input: {
  readonly authorization: DirectDeepSeek500SpendAuthorization;
  readonly cacheRoot: string;
}): void {
  discardFreshExtractionTargetRoot({
    cacheRoot: input.cacheRoot,
    marker: directRootMarker,
    purpose: "direct DeepSeek 500 authorization",
    binding: input.authorization
  });
}

export function discardFreshNewApiDeepSeek500Authorization(input: {
  readonly authorization: NewApiDeepSeek500SpendAuthorization;
  readonly cacheRoot: string;
}): void {
  discardFreshExtractionTargetRoot({
    cacheRoot: input.cacheRoot,
    marker: newApiRootMarker,
    purpose: "direct NewAPI DeepSeek 500 authorization",
    binding: input.authorization
  });
}

export function discardFreshDirectExtractionSpendAuthorization(input: {
  readonly authorization: DirectExtractionSpendAuthorization;
  readonly cacheRoot: string;
}): void {
  if (isDirectDeepSeek500Authorization(input.authorization)) {
    discardFreshDirectDeepSeek500Authorization({
      authorization: input.authorization,
      cacheRoot: input.cacheRoot
    });
    return;
  }
  discardFreshNewApiDeepSeek500Authorization({
    authorization: input.authorization,
    cacheRoot: input.cacheRoot
  });
}

export function isDirectDeepSeek500Authorization(
  value: unknown
): value is DirectDeepSeek500SpendAuthorization {
  if (typeof value !== "object" || value === null) return false;
  const authorization = value as Partial<DirectDeepSeek500SpendAuthorization>;
  return authorization.kind === "deepseek_direct_500" &&
    authorization.requests_per_minute === DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE &&
    hasRootBindingShape(authorization);
}

export function isNewApiDeepSeek500Authorization(
  value: unknown
): value is NewApiDeepSeek500SpendAuthorization {
  if (typeof value !== "object" || value === null) return false;
  const authorization = value as Partial<NewApiDeepSeek500SpendAuthorization>;
  return authorization.kind === "deepseek_newapi_direct_500" && hasRootBindingShape(authorization);
}

export function isDirectExtractionSpendAuthorization(
  value: unknown
): value is DirectExtractionSpendAuthorization {
  return isDirectDeepSeek500Authorization(value) || isNewApiDeepSeek500Authorization(value);
}

function isFreshNonthinkingDeepSeek500Observation(
  observation: ExtractionAuthorityObservation,
  model: string
): boolean {
  const { dataset, extraction, inventory } = observation;
  return dataset.variant === "longmemeval_s" && dataset.windowOffset === 0 &&
    dataset.windowLimit === 500 && extraction.model === model &&
    extraction.modelFamily === DIRECT_DEEPSEEK_500_MODEL_FAMILY &&
    extraction.requestProfile === DIRECT_DEEPSEEK_500_REQUEST_PROFILE &&
    extraction.manifestSha256 === null && inventory.expectedTurns > 0 &&
    inventory.validTurns === 0 && inventory.missingTurns === inventory.expectedTurns &&
    inventory.invalidTurns === 0 && inventory.orphanTurns === 0;
}

function hasValidRootBinding(authorization: ExtractionTargetRootBinding & { operator: string }): boolean {
  return requireOperator(authorization.operator) === authorization.operator &&
    isSha256(authorization.cache_root_sha256) &&
    isNonnegativeIntegerString(authorization.cache_root_device) &&
    isNonnegativeIntegerString(authorization.cache_root_inode) &&
    isSha256(authorization.cache_root_marker_sha256);
}

function hasRootBindingShape(
  authorization: Partial<ExtractionTargetRootBinding & { operator: string }>
): boolean {
  return typeof authorization.operator === "string" &&
    typeof authorization.cache_root_sha256 === "string" &&
    typeof authorization.cache_root_device === "string" &&
    typeof authorization.cache_root_inode === "string" &&
    typeof authorization.cache_root_marker_sha256 === "string";
}

function requireOperator(value: string): string {
  if (value.trim().length === 0) throw new Error("direct DeepSeek 500 operator is required");
  return value;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isNonnegativeIntegerString(value: string): boolean {
  return /^\d+$/u.test(value);
}
