import { createHash } from "node:crypto";
import { AlayaError, canonicalJson, isChatSemanticRequestProfile } from "@do-soul/alaya-protocol";
import type { ExtractionAuthorityObservation } from "./receipt.js";
import { isNativeGeminiRequestProfile } from "../request-profile.js";

/** Bench-private creation policy. New key/rule configurations require a new identity. */
export interface ExtractionSamplePolicy {
  readonly identity: string;
  readonly manifest: string;
  readonly rules: Readonly<{
    inventory: "first-100" | "interactive-preflight";
    allowedKeys?: readonly string[];
    maximumKeys?: number;
  }>;
}
export interface ExtractionSamplePolicyBinding {
  readonly identity: string;
  readonly manifest_sha256: string;
}

export function createExtractionSamplePolicyRegistry(policies: readonly ExtractionSamplePolicy[]) {
  const entries = new Map<string, Readonly<{ policy: ExtractionSamplePolicy; binding: ExtractionSamplePolicyBinding }>>();
  for (const input of policies) {
    if (!input.identity.trim() || !input.manifest.trim() || entries.has(input.identity) ||
        !["first-100", "interactive-preflight"].includes(input.rules.inventory) ||
        input.rules.maximumKeys !== undefined && (!Number.isSafeInteger(input.rules.maximumKeys) || input.rules.maximumKeys < 1)) {
      throw new AlayaError("VALIDATION", "sample policy registry requires unique explicit identities and valid rules");
    }
    const policy = Object.freeze({ ...input, rules: Object.freeze({ ...input.rules,
      ...(input.rules.allowedKeys === undefined ? {} : { allowedKeys: Object.freeze([...input.rules.allowedKeys].sort()) }) }) });
    const binding = Object.freeze({ identity: policy.identity,
      manifest_sha256: createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex") });
    entries.set(policy.identity, Object.freeze({ policy, binding }));
  }
  return Object.freeze({
    binding(identity: string): ExtractionSamplePolicyBinding {
      const entry = entries.get(identity);
      if (entry === undefined) throw new AlayaError("VALIDATION", "unknown sample policy identity");
      return entry.binding;
    },
    assert(binding: ExtractionSamplePolicyBinding | undefined, observation: ExtractionAuthorityObservation,
      keys: readonly string[], preflight: boolean): void {
      const entry = binding === undefined ? undefined : entries.get(binding.identity);
      if (entry === undefined || binding?.manifest_sha256 !== entry.binding.manifest_sha256) {
        throw new AlayaError("CONFLICT", "missing, unknown or changed sample policy manifest");
      }
      const { rules } = entry.policy;
      const dataset = observation.dataset;
      const interactive = observation.extraction.sourcePacking === "complete-source" &&
        (isChatSemanticRequestProfile(observation.extraction.requestProfile) ||
          isNativeGeminiRequestProfile(observation.extraction.requestProfile));
      if (rules.inventory === "first-100"
        ? dataset.variant !== "longmemeval_s" || dataset.windowOffset !== 0 || dataset.windowLimit !== 100 || preflight
        : !interactive || !preflight) {
        throw new AlayaError("VALIDATION", "sample policy requires its first-100 inventory or retained interactive preflight");
      }
      if (rules.maximumKeys !== undefined && keys.length > rules.maximumKeys ||
          rules.allowedKeys !== undefined && keys.some(key => !rules.allowedKeys!.includes(key))) {
        throw new AlayaError("VALIDATION", "sample keys exceed their explicit policy configuration");
      }
    }
  });
}

export const extractionSamplePolicies = createExtractionSamplePolicyRegistry([
  { identity: "longmemeval-first-100-sample-v1", manifest: "recall-handbook-first-100-v1", rules: { inventory: "first-100" } },
  { identity: "complete-source-interactive-sample-v1", manifest: "source-semantic-interactive-preflight-v3", rules: { inventory: "interactive-preflight" } }
]);
