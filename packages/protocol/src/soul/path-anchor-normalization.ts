import {
  CanonicalAliasDomain,
  type CanonicalAliasResolver
} from "./canonical-alias.js";
import { canonicalizeToken } from "./governance-subject.js";
import type { PathAnchorRef } from "./path-relation.js";

export const PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND = Object.freeze({
  obligation: CanonicalAliasDomain.PATH_ANCHOR_OBLIGATION,
  concern: CanonicalAliasDomain.PATH_ANCHOR_CONCERN,
  window: CanonicalAliasDomain.PATH_ANCHOR_WINDOW
} as const);

export type PathAnchorDigestKind = keyof typeof PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND;

export function normalizePathAnchorDigest(
  digest: string,
  digestKind: PathAnchorDigestKind,
  aliasResolver?: CanonicalAliasResolver
): string {
  const aliasDomain = PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND[digestKind];
  const resolvedDigest = aliasResolver === undefined ? digest : aliasResolver(digest, aliasDomain);
  const normalizedDigest = canonicalizeToken(resolvedDigest);

  if (normalizedDigest.length === 0) {
    throw new Error("path anchor digest must not normalize to empty.");
  }

  return normalizedDigest;
}

export function normalizePathAnchorRef(
  ref: PathAnchorRef,
  aliasResolver?: CanonicalAliasResolver
): PathAnchorRef {
  switch (ref.kind) {
    case "object":
    case "object_facet":
      return ref;
    case "obligation":
      return {
        ...ref,
        obligation_digest: normalizePathAnchorDigest(ref.obligation_digest, "obligation", aliasResolver)
      };
    case "risk_concern":
      return {
        ...ref,
        concern_digest: normalizePathAnchorDigest(ref.concern_digest, "concern", aliasResolver)
      };
    case "time_concern":
      return {
        ...ref,
        window_digest: normalizePathAnchorDigest(ref.window_digest, "window", aliasResolver)
      };
  }
}
