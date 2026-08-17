import { readStableRegularFileNoFollow } from "./materialization/descriptor-io.js";
import { MAX_SOURCE_MANIFEST_BYTES } from "./materialization/preflight.js";

export interface AuditedSourceManifestArtifact {
  readonly raw: string;
  readonly sha256: string;
}

export function readAuditedSourceManifestArtifact(
  path: string
): AuditedSourceManifestArtifact {
  const artifact = readStableRegularFileNoFollow(path, MAX_SOURCE_MANIFEST_BYTES);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(artifact.bytes);
  } catch (cause) {
    throw new Error("audited source manifest is not valid UTF-8", { cause });
  }
  if (!Buffer.from(raw, "utf8").equals(artifact.bytes)) {
    throw new Error("audited source manifest UTF-8 bytes are not canonical");
  }
  return Object.freeze({ raw, sha256: artifact.identity.sha256 });
}
