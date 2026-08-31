import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type { ExtractionCacheWriteLease } from "../fill/manifest/fill-root-guard.js";
import {
  canonicalExtractionTargetRoot,
  type ExtractionTargetRootBinding
} from "./target-root-binding.js";
import type { ExtractionAuthorityObservation } from "./receipt.js";

export interface DirectExtractionSpendAuthorization extends ExtractionTargetRootBinding {
  readonly kind: string;
  readonly operator: string;
  readonly requests_per_minute?: number;
}

export function isDirectExtractionSpendAuthorization(
  value: unknown
): value is DirectExtractionSpendAuthorization {
  if (typeof value !== "object" || value === null) return false;
  const authorization = value as Partial<DirectExtractionSpendAuthorization>;
  return typeof authorization.kind === "string" &&
    authorization.kind.length > 0 &&
    typeof authorization.operator === "string" &&
    authorization.operator.trim().length > 0 &&
    typeof authorization.cache_root_sha256 === "string" &&
    typeof authorization.cache_root_device === "string" &&
    typeof authorization.cache_root_inode === "string" &&
    typeof authorization.cache_root_marker_sha256 === "string";
}

export function assertDirectExtractionSpendAuthorization(input: {
  readonly action: "probe" | "fill";
  readonly authorization: DirectExtractionSpendAuthorization;
  readonly observation: ExtractionAuthorityObservation;
}): void {
  if (input.action !== "fill" || !isDirectExtractionSpendAuthorization(input.authorization)) {
    throw new Error("direct extraction spend authorization is invalid");
  }
}

export function assertDirectExtractionSpendRootBinding(input: {
  readonly authorization: DirectExtractionSpendAuthorization;
  readonly cacheRoot: string;
  readonly writeLease?: ExtractionCacheWriteLease;
}): void {
  input.writeLease?.assertOwned();
  const root = canonicalExtractionTargetRoot(input.cacheRoot);
  const stat = lstatSync(root, { bigint: true });
  const rootSha256 = createHash("sha256").update(root, "utf8").digest("hex");
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      rootSha256 !== input.authorization.cache_root_sha256 ||
      stat.dev.toString() !== input.authorization.cache_root_device ||
      stat.ino.toString() !== input.authorization.cache_root_inode) {
    throw new Error("direct extraction spend authorization target root changed");
  }
}

export function discardFreshDirectExtractionSpendAuthorization(input: {
  readonly authorization: DirectExtractionSpendAuthorization;
  readonly cacheRoot: string;
}): void {
  void input;
}
