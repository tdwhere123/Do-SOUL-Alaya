import { readFileSync } from "node:fs";
import process from "node:process";
import { resolveSecretRef } from "@do-soul/alaya";
import { parseSemanticProposalWorkset, SEMANTIC_PROPOSAL_OUTPUT_TOKEN_DEFAULT } from "../../runs/semantic-proposal/workset.js";
import {
  parseSemanticProposalPreflight, pinSemanticProposalAuthority, readSemanticProposalAuthority,
  writeJsonExclusive, DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY
} from "../../runs/semantic-proposal/authority.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../runs/semantic-proposal/fill.js";
import type { CompileSeedExtractionConfig } from "../../runs/compile-seed/compile-seed-types.js";
import { isNativeGeminiRequestProfile } from "../../runs/extraction/request-profile.js";
import { canonicalExtractionTargetRoot } from "../../runs/extraction/authority/target-root-binding.js";

export async function runSemanticProposalFillCommand(args: ReadonlyArray<string>): Promise<number> {
  try {
    const action = required(args, "--action");
    const kind = required(args, "--kind");
    if (kind !== "query" && kind !== "semantic_correspondence") throw new Error("--kind must be query or semantic_correspondence");
    if (action !== "prepare" && action !== "authorize" && action !== "fill") {
      throw new Error("--action must be prepare, authorize, or fill");
    }
    const workset = parseSemanticProposalWorkset(JSON.parse(readFileSync(required(args, "--workset"), "utf8")));
    if (workset.kind !== kind) throw new Error("workset kind does not match --kind");
    const cacheRoot = required(args, "--cache-root");
    const maxOutputTokens = integerFlag(args, "--max-output-tokens", SEMANTIC_PROPOSAL_OUTPUT_TOKEN_DEFAULT);
    if (action === "prepare") {
      const preflight = prepareSemanticProposal(workset, cacheRoot, maxOutputTokens,
        integerFlag(args, "--max-attempts-per-key", DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY));
      writeJsonExclusive(required(args, "--preflight-out"), preflight);
      process.stdout.write(`${JSON.stringify(preflight)}\n`);
      return 0;
    }
    if (action === "authorize") {
      const preflight = parseSemanticProposalPreflight(JSON.parse(readFileSync(required(args, "--preflight"), "utf8")));
      if (canonicalExtractionTargetRoot(cacheRoot) !== preflight.execution_scope.execution_root_path) {
        throw new Error("semantic proposal preflight execution root differs from selected root");
      }
      const authority = pinSemanticProposalAuthority({
        preflight,
        inputUsdPerMillion: numberFlag(args, "--input-price-usd-per-million"),
        outputUsdPerMillion: numberFlag(args, "--output-price-usd-per-million"),
        ...(hasFlag(args, "--spend-ceiling-usd")
          ? { spendCeilingUsd: numberFlag(args, "--spend-ceiling-usd") } : {})
      });
      writeJsonExclusive(required(args, "--receipt-out"), authority);
      process.stdout.write(`${JSON.stringify({
        estimated_upper_usd: authority.price.estimated_upper_usd,
        starting_missing: authority.limits.starting_missing,
        maximum_attempts_per_key: authority.limits.maximum_attempts_per_key,
        maximum_attempts: authority.limits.maximum_attempts
      })}\n`);
      return 0;
    }
    const result = await executeSemanticProposalFill({
      workset, cacheRoot, authority: readSemanticProposalAuthority(required(args, "--authority")),
      config: gardenConfig(workset.model, workset.request_profile, workset.provider_url)
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`alaya-bench-runner semantic-proposal-fill: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
    return 2;
  }
}

function gardenConfig(model: string, requestProfile: string, authorizedProviderUrl: string): CompileSeedExtractionConfig {
  if (!isNativeGeminiRequestProfile(requestProfile)) {
    throw new Error("semantic proposal fill requires a native Gemini request profile");
  }
  const providerUrl = process.env.OFFICIAL_API_GARDEN_PROVIDER_URL?.trim()
    || authorizedProviderUrl;
  return { providerUrl, model, requestProfile, apiKey: gardenApiKey() };
}

function gardenApiKey(): string | null {
  const secretRef = process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF?.trim();
  if (secretRef !== undefined && secretRef.length > 0) {
    const resolved = resolveSecretRef(secretRef);
    if ("value" in resolved && typeof resolved.value === "string" && resolved.value.trim().length > 0) {
      return resolved.value;
    }
  }
  const direct = process.env.OFFICIAL_API_GARDEN_API_KEY?.trim();
  return direct === undefined || direct.length === 0 ? null : direct;
}

function required(args: ReadonlyArray<string>, name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
  return args.includes(name);
}

function integerFlag(args: ReadonlyArray<string>, name: string, fallback: number): number {
  if (!hasFlag(args, name)) return fallback;
  const value = Number(required(args, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function numberFlag(args: ReadonlyArray<string>, name: string): number {
  const value = Number(required(args, name));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}
