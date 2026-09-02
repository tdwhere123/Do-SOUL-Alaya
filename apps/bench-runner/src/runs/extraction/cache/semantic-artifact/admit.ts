import { createHash } from "node:crypto";
import {
  parseOfficialApiSignals,
  parseOfficialApiSourceLocator
} from "@do-soul/alaya-soul";
import {
  capabilitiesAreCompatible,
  resolveExtractionCapability
} from "./capability.js";
import {
  sealSemanticArtifact,
  type SemanticArtifact,
  type SemanticArtifactSourceBinding
} from "./contract.js";
import { inspectSemanticArtifact, persistRawArtifact } from "./store.js";

export interface AdmissionTask {
  readonly semanticKey: string;
  readonly capability: string;
  readonly semanticContract: string;
  readonly modelFamily: string;
  readonly modelId: string;
  readonly requestProfile: string;
  readonly providerUrlSha256: string;
  readonly binding: SemanticArtifactSourceBinding;
  readonly assertionId: number;
}

export type RawAdmission =
  | { readonly kind: "provider_backed"; readonly artifact: SemanticArtifact; readonly semanticKey: string }
  | { readonly kind: "unresolved"; readonly reason: string; readonly semanticKey: string };

export function admitProviderRaw(input: {
  readonly root: string;
  readonly rawJson: string;
  readonly tasks: readonly AdmissionTask[];
}): readonly RawAdmission[] {
  const digest = digestCanonicalRaw(input.rawJson);
  if (digest.kind === "unresolved") {
    return input.tasks.map((task) => ({
      kind: "unresolved",
      reason: digest.reason,
      semanticKey: task.semanticKey
    }));
  }
  persistRawArtifact(input.root, input.rawJson);
  let drafts: ReturnType<typeof parseOfficialApiSignals>;
  try {
    drafts = parseOfficialApiSignals(input.rawJson);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return input.tasks.map((task) => ({
      kind: "unresolved",
      reason: `parser drop: ${reason}`,
      semanticKey: task.semanticKey
    }));
  }
  if (drafts.length === 0) {
    return input.tasks.map((task) => ({
      kind: "unresolved",
      reason: "batch-empty is not assertion-empty without exhaustive inspection proof",
      semanticKey: task.semanticKey
    }));
  }
  const claimed = new Map<number, number>();
  const byAssertion = new Map(input.tasks.map((task) => [task.assertionId, task]));
  const accepted = new Set<string>();
  for (const draft of drafts) {
    const locator = parseOfficialApiSourceLocator(draft.source_locator);
    if (locator === null) continue;
    claimed.set(locator.assertion_id, (claimed.get(locator.assertion_id) ?? 0) + 1);
    if ((claimed.get(locator.assertion_id) ?? 0) > 1) {
      accepted.delete(byAssertion.get(locator.assertion_id)?.semanticKey ?? "");
      continue;
    }
    const task = byAssertion.get(locator.assertion_id);
    if (task === undefined) continue;
    accepted.add(task.semanticKey);
  }
  for (const [assertionId, count] of claimed) {
    if (count > 1) accepted.delete(byAssertion.get(assertionId)?.semanticKey ?? "");
  }
  return input.tasks.map((task) => {
    if (!accepted.has(task.semanticKey) || (claimed.get(task.assertionId) ?? 0) !== 1) {
      return {
        kind: "unresolved",
        reason: "no injective in-pack signal",
        semanticKey: task.semanticKey
      };
    }
    const missing = missingCapabilityRequirements(input.root, task);
    if (missing !== undefined) {
      return { kind: "unresolved", reason: missing, semanticKey: task.semanticKey };
    }
    return {
      kind: "provider_backed",
      semanticKey: task.semanticKey,
      artifact: sealSemanticArtifact({
        schema_version: 1,
        kind: "assertion_semantic_artifact_v1",
        semantic_key: task.semanticKey,
        semantic_contract: task.semanticContract,
        capability: task.capability,
        capability_set: [task.capability],
        model_family: task.modelFamily,
        model_id: task.modelId,
        admission_state: "provider_backed",
        source_bindings: [task.binding],
        raw_response_digest: digest.sha256,
        provider_provenance: {
          provider_url_sha256: task.providerUrlSha256,
          request_profile: task.requestProfile,
          model_id: task.modelId
        }
      })
    };
  });
}

export function promptSha256(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function digestCanonicalRaw(
  rawJson: string
): { kind: "ok"; sha256: string } | { kind: "unresolved"; reason: string } {
  const bytes = Buffer.from(rawJson, "utf8");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== rawJson) {
    return { kind: "unresolved", reason: "raw artifact UTF-8 bytes are not canonical" };
  }
  try {
    const parsed = JSON.parse(rawJson) as { signals?: unknown };
    if (!Array.isArray(parsed.signals)) {
      return { kind: "unresolved", reason: "raw artifact signals array missing" };
    }
  } catch {
    return { kind: "unresolved", reason: "raw artifact is not strict JSON" };
  }
  return { kind: "ok", sha256: createHash("sha256").update(rawJson, "utf8").digest("hex") };
}

function missingCapabilityRequirements(root: string, task: AdmissionTask): string | undefined {
  const contract = resolveExtractionCapability(task.capability);
  const available = contract.requirements.filter((capability) => {
    const inspected = inspectSemanticArtifact(root, task.semanticKey, capability);
    return inspected.status === "provider_backed" || inspected.status === "deterministic_empty";
  });
  if (!capabilitiesAreCompatible(contract.requirements, available)) {
    return "capability requirements unavailable";
  }
  return undefined;
}
