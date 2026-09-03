import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  readBoundedCanonicalUtf8Artifact,
  withRootBoundDirectory
} from "../../cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from
  "../../fill/manifest/durable-exclusive-publication.js";
import { bindingSegments } from "./derived-path.js";
import {
  parseSemanticArtifactSourceBinding,
  SEMANTIC_ARTIFACT_MAX_BYTES,
  type SemanticArtifactSourceBinding
} from "./contract.js";

export function recordedSourceBindings(
  root: string,
  semanticKey: string,
  capability: string
): readonly SemanticArtifactSourceBinding[] {
  try {
    return withRootBoundDirectory({
      root, segments: bindingSegments(semanticKey, capability), label: "semantic artifact bindings"
    }, (directory) => Object.freeze(readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => readVerifiedBinding(directory, entry.name))
      .sort((left, right) => digestBinding(left).localeCompare(digestBinding(right)))));
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return [];
    throw cause;
  }
}

export function recordSourceBinding(
  root: string,
  semanticKey: string,
  capability: string,
  binding: SemanticArtifactSourceBinding
): void {
  if (binding.semanticKey !== semanticKey) throw new Error("binding semantic key mismatch");
  parseSemanticArtifactSourceBinding(binding);
  withRootBoundDirectory({
    root, segments: bindingSegments(semanticKey, capability), createSegments: true,
    label: "semantic artifact binding"
  }, (directory, stableRoot) => {
    withRootBoundDirectory({
      root: stableRoot, segments: [".tmp"], createSegments: true, label: "semantic artifact binding"
    }, (temporaryDirectory) => {
      const identity = digestBinding(binding);
      publishBytesExclusiveDurable({
        destination: `${directory}/${identity}.json`,
        bytes: Buffer.from(`${JSON.stringify(binding, null, 2)}\n`, "utf8"),
        ownerIdentity: identity,
        temporaryDirectory,
        allowExistingExact: true
      });
    });
  });
}

export function writeArtifactBindings(
  root: string,
  semanticKey: string,
  capability: string,
  bindings: readonly SemanticArtifactSourceBinding[]
): void {
  for (const binding of bindings) recordSourceBinding(root, semanticKey, capability, binding);
}

export function digestBinding(binding: SemanticArtifactSourceBinding): string {
  return createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex");
}

export function digestBindingSet(bindings: readonly SemanticArtifactSourceBinding[]): string {
  return createHash("sha256").update(bindings.map(digestBinding).sort().join("\n"), "utf8").digest("hex");
}

function readVerifiedBinding(
  directory: string,
  filename: string
): SemanticArtifactSourceBinding {
  const named = /^([a-f0-9]{64})\.json$/u.exec(filename);
  if (named === null) throw new Error("semantic artifact binding filename is invalid");
  const binding = parseSemanticArtifactSourceBinding(JSON.parse(
    readBoundedCanonicalUtf8Artifact({
      path: `${directory}/${filename}`,
      maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
      label: "semantic artifact binding"
    })
  ));
  if (digestBinding(binding) !== named[1]) {
    throw new Error("semantic artifact binding filename digest mismatch");
  }
  return binding;
}

function hasCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}
