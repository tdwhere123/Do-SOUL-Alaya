import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtractionAuthorityObservation } from "./receipt.js";

export const DIRECT_DEEPSEEK_500_MAX_CONCURRENCY = 64;
const ROOT_MARKER_FILENAME = ".alaya-direct-deepseek-500-root.json";

export interface DirectDeepSeek500SpendAuthorization {
  readonly kind: "deepseek_direct_500";
  readonly operator: string;
  readonly cache_root_sha256: string;
  readonly cache_root_device: string;
  readonly cache_root_inode: string;
  readonly cache_root_marker_sha256: string;
}

export function createFreshDirectDeepSeek500Authorization(input: {
  readonly cacheRoot: string;
  readonly operator: string;
}): DirectDeepSeek500SpendAuthorization {
  const operator = requireOperator(input.operator);
  const root = canonicalRoot(input.cacheRoot);
  const identity = createFreshRoot(root);
  return Object.freeze({
    kind: "deepseek_direct_500",
    operator,
    cache_root_sha256: hashRoot(root),
    cache_root_device: identity.device,
    cache_root_inode: identity.inode,
    cache_root_marker_sha256: identity.markerSha256
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
      !isSha256(authorization.cache_root_marker_sha256)) {
    throw new Error("direct DeepSeek 500 authorization is invalid");
  }
  if (input.action !== "fill" || !isFreshDeepSeek500Observation(input.observation)) {
    throw new Error("direct DeepSeek 500 authorization has the wrong extraction scope");
  }
}

export function assertDirectDeepSeek500RootBinding(input: {
  readonly authorization: DirectDeepSeek500SpendAuthorization;
  readonly cacheRoot: string;
}): void {
  const root = canonicalRoot(input.cacheRoot);
  const stat = lstatSync(root, { bigint: true });
  const marker = readMarkerSha256(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      hashRoot(root) !== input.authorization.cache_root_sha256 ||
      stat.dev.toString() !== input.authorization.cache_root_device ||
      stat.ino.toString() !== input.authorization.cache_root_inode ||
      marker !== input.authorization.cache_root_marker_sha256) {
    throw new Error("direct DeepSeek 500 authorization target root changed");
  }
}

export function discardFreshDirectDeepSeek500Authorization(input: {
  readonly authorization: DirectDeepSeek500SpendAuthorization;
  readonly cacheRoot: string;
}): void {
  try {
    assertDirectDeepSeek500RootBinding(input);
    unlinkSync(markerPath(canonicalRoot(input.cacheRoot)));
    rmdirSync(canonicalRoot(input.cacheRoot));
  } catch {
    // A failed preflight must never remove a root that acquired content or changed identity.
  }
}

export function isDirectDeepSeek500Authorization(
  value: unknown
): value is DirectDeepSeek500SpendAuthorization {
  if (typeof value !== "object" || value === null) return false;
  const authorization = value as Partial<DirectDeepSeek500SpendAuthorization>;
  return authorization.kind === "deepseek_direct_500" &&
    typeof authorization.operator === "string" &&
    typeof authorization.cache_root_sha256 === "string" &&
    typeof authorization.cache_root_device === "string" &&
    typeof authorization.cache_root_inode === "string" &&
    typeof authorization.cache_root_marker_sha256 === "string";
}

function isFreshDeepSeek500Observation(observation: ExtractionAuthorityObservation): boolean {
  const { dataset, extraction, inventory } = observation;
  return dataset.variant === "longmemeval_s" && dataset.windowOffset === 0 &&
    dataset.windowLimit === 500 && extraction.model === "deepseek-v4-flash" &&
    extraction.modelFamily === "deepseek-v4-flash-nonthinking" &&
    extraction.requestProfile === "deepseek-v4-nonthinking-v1" &&
    extraction.providerUrl === "https://ai.loli.sh.cn/v1" &&
    extraction.manifestSha256 === null && inventory.expectedTurns > 0 &&
    inventory.validTurns === 0 && inventory.missingTurns === inventory.expectedTurns &&
    inventory.invalidTurns === 0 && inventory.orphanTurns === 0;
}

function createFreshRoot(root: string): {
  readonly device: string;
  readonly inode: string;
  readonly markerSha256: string;
} {
  try {
    mkdirSync(root);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`direct DeepSeek 500 target root must be new: ${detail}`);
  }
  const stat = lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("direct DeepSeek 500 target root is not a real directory");
  }
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    markerSha256: writeRootMarker(root)
  });
}

function canonicalRoot(cacheRoot: string): string {
  const absolute = resolve(cacheRoot);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

function hashRoot(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex");
}

function writeRootMarker(root: string): string {
  const marker = `${JSON.stringify({
    kind: "alaya_direct_deepseek_500_root",
    root_id: randomUUID()
  })}\n`;
  writeFileSync(markerPath(root), marker, { encoding: "utf8", flag: "wx" });
  return hashBytes(Buffer.from(marker, "utf8"));
}

function readMarkerSha256(root: string): string {
  try {
    const marker = markerPath(root);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("marker is not a file");
    return hashBytes(readFileSync(marker));
  } catch {
    throw new Error("direct DeepSeek 500 authorization target root changed");
  }
}

function markerPath(root: string): string {
  return join(root, ROOT_MARKER_FILENAME);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
