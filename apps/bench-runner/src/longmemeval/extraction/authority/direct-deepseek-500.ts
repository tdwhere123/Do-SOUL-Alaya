import type { ExtractionAuthorityObservation } from "./receipt.js";
import {
  assertExtractionTargetRootBinding,
  createFreshExtractionTargetRoot,
  discardFreshExtractionTargetRoot,
  type ExtractionTargetRootBinding
} from "./target-root-binding.js";

export const DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE = 30;
const DIRECT_DEEPSEEK_500_MODEL_FAMILY = "deepseek-v4-flash-nonthinking";
const DIRECT_DEEPSEEK_500_REQUEST_PROFILE = "deepseek-v4-nonthinking-v1";
const directRootMarker = {
  filename: ".alaya-direct-deepseek-500-root.json",
  kind: "alaya_direct_deepseek_500_root"
} as const;

export interface DirectDeepSeek500SpendAuthorization extends ExtractionTargetRootBinding {
  readonly kind: "deepseek_direct_500";
  readonly operator: string;
  readonly requests_per_minute: typeof DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE;
}

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

export function assertDirectDeepSeek500Authorization(input: {
  readonly action: "probe" | "fill";
  readonly authorization: DirectDeepSeek500SpendAuthorization;
  readonly observation: ExtractionAuthorityObservation;
}): void {
  const authorization = input.authorization;
  if (authorization.kind !== "deepseek_direct_500" ||
      requireOperator(authorization.operator) !== authorization.operator ||
      !isSha256(authorization.cache_root_sha256) ||
      !isNonnegativeIntegerString(authorization.cache_root_device) ||
      !isNonnegativeIntegerString(authorization.cache_root_inode) ||
      !isSha256(authorization.cache_root_marker_sha256) ||
      authorization.requests_per_minute !== DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE) {
    throw new Error("direct DeepSeek 500 authorization is invalid");
  }
  if (input.action !== "fill" || !isFreshNonthinkingDeepSeek500Observation(input.observation)) {
    throw new Error("direct DeepSeek 500 authorization has the wrong extraction scope");
  }
}

export function assertDirectDeepSeek500RootBinding(input: {
  readonly authorization: DirectDeepSeek500SpendAuthorization;
  readonly cacheRoot: string;
}): void {
  assertExtractionTargetRootBinding({
    cacheRoot: input.cacheRoot,
    marker: directRootMarker,
    purpose: "direct DeepSeek 500 authorization",
    binding: input.authorization
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

export function isDirectDeepSeek500Authorization(
  value: unknown
): value is DirectDeepSeek500SpendAuthorization {
  if (typeof value !== "object" || value === null) return false;
  const authorization = value as Partial<DirectDeepSeek500SpendAuthorization>;
  return authorization.kind === "deepseek_direct_500" &&
    typeof authorization.operator === "string" &&
    authorization.requests_per_minute === DIRECT_DEEPSEEK_500_REQUESTS_PER_MINUTE &&
    typeof authorization.cache_root_sha256 === "string" &&
    typeof authorization.cache_root_device === "string" &&
    typeof authorization.cache_root_inode === "string" &&
    typeof authorization.cache_root_marker_sha256 === "string";
}

function isFreshNonthinkingDeepSeek500Observation(
  observation: ExtractionAuthorityObservation
): boolean {
  const { dataset, extraction, inventory } = observation;
  return dataset.variant === "longmemeval_s" && dataset.windowOffset === 0 &&
    dataset.windowLimit === 500 && extraction.model === "deepseek-v4-flash" &&
    extraction.modelFamily === DIRECT_DEEPSEEK_500_MODEL_FAMILY &&
    extraction.requestProfile === DIRECT_DEEPSEEK_500_REQUEST_PROFILE &&
    extraction.manifestSha256 === null && inventory.expectedTurns > 0 &&
    inventory.validTurns === 0 && inventory.missingTurns === inventory.expectedTurns &&
    inventory.invalidTurns === 0 && inventory.orphanTurns === 0;
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
