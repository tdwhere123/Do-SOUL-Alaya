import { join } from "node:path";
import { resolveExtractionCapability } from "./capability.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority
} from "./replay-authority.js";

export function currentReplayIdentityDigest(): string {
  return semanticReplayIdentityDigest(
    unwrapSemanticReplayAuthority(currentSemanticReplayAuthority())
  );
}

export function semanticArtifactPath(
  root: string,
  semanticKey: string,
  capability: string,
  replayIdentityDigest: string = currentReplayIdentityDigest()
): string {
  return join(
    root,
    artifactPrefix(semanticKey),
    artifactFilename(semanticKey, capability, replayIdentityDigest)
  );
}

export function artifactPrefix(semanticKey: string): string {
  assertHex64(semanticKey, "semantic key");
  return semanticKey.slice(0, 2);
}

export function artifactFilename(
  semanticKey: string,
  capability: string,
  replayIdentityDigest: string = currentReplayIdentityDigest()
): string {
  assertSemanticPathIdentity(semanticKey, capability);
  assertHex64(replayIdentityDigest, "replay identity digest");
  return `${semanticKey}.${encodeURIComponent(capability)}.${replayIdentityDigest}.json`;
}

export function parseArtifactFilename(filename: string): {
  readonly semanticKey: string;
  readonly capability: string;
  readonly replayIdentityDigest: string;
} | undefined {
  const match = /^([a-f0-9]{64})\.(.+)\.([a-f0-9]{64})\.json$/u.exec(filename);
  if (match === null) return undefined;
  try {
    const capability = decodeURIComponent(match[2]!);
    assertSemanticPathIdentity(match[1]!, capability);
    assertHex64(match[3]!, "replay identity digest");
    return {
      semanticKey: match[1]!,
      capability,
      replayIdentityDigest: match[3]!
    };
  } catch {
    return undefined;
  }
}

export function bindingSegments(
  semanticKey: string,
  capability: string
): readonly string[] {
  assertSemanticPathIdentity(semanticKey, capability);
  return ["bindings", semanticKey, encodeURIComponent(capability)];
}

export function assertSemanticPathIdentity(semanticKey: string, capability: string): void {
  assertHex64(semanticKey, "semantic key");
  resolveExtractionCapability(capability);
  if (capability.includes("/") || capability.includes("\\") || capability.includes("..")) {
    throw new Error("semantic capability path is invalid");
  }
}

export function assertHex64(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
}
