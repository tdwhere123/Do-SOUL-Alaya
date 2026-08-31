import { z } from "zod";
import { sourceBoundF3Seal } from "@do-soul/alaya-soul";
import { EXTRACTION_REQUEST_PROFILES } from "../extraction/request-profile.js";
import type { ReplayRequestManifest } from
  "../../cli/provider-preflight/replay-request-manifest.js";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ProviderPreflightReplayReceiptSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal("provider_preflight_replay_receipt"),
  provider_port: z.literal("absent"),
  physical_calls: z.literal(0),
  model: z.string().min(1),
  profile: z.enum(EXTRACTION_REQUEST_PROFILES),
  key_count: z.number().int().nonnegative(),
  request_manifest_sha256: Sha256HexSchema,
  cache_manifest_sha256: Sha256HexSchema,
  evidence_prompt_sha256: Sha256HexSchema,
  query_prompt_sha256: Sha256HexSchema,
  evidence_request_template_sha256: Sha256HexSchema,
  query_request_template_sha256: Sha256HexSchema
}).strict().readonly();

export type ProviderPreflightReplayReceipt =
  z.infer<typeof ProviderPreflightReplayReceiptSchema>;

export function verifyProviderPreflightReplayReceipt(
  value: unknown
): ProviderPreflightReplayReceipt {
  const receipt = ProviderPreflightReplayReceiptSchema.parse(value);
  const seal = sourceBoundF3Seal();
  if (receipt.evidence_prompt_sha256 !== seal.evidence_prompt_sha256 ||
      receipt.query_prompt_sha256 !== seal.query_prompt_sha256 ||
      receipt.evidence_request_template_sha256 !==
        seal.evidence_request_template_sha256 ||
      receipt.query_request_template_sha256 !== seal.query_request_template_sha256) {
    throw new Error("provider replay receipt semantic contract does not match this runtime");
  }
  return receipt;
}

export function parseProviderPreflightReplayReceiptJson(
  rawJson: string
): ProviderPreflightReplayReceipt {
  return verifyProviderPreflightReplayReceipt(JSON.parse(rawJson) as unknown);
}

export function verifyProviderPreflightReplayReceiptBinding(
  value: unknown,
  manifest: ReplayRequestManifest
): ProviderPreflightReplayReceipt {
  const receipt = verifyProviderPreflightReplayReceipt(value);
  if (receipt.model !== manifest.request.model ||
      receipt.profile !== manifest.request.requestProfile ||
      receipt.key_count !== manifest.request.requestedKeys.length ||
      receipt.request_manifest_sha256 !== manifest.request_manifest_sha256 ||
      receipt.cache_manifest_sha256 !== manifest.cache_authority.manifest_sha256) {
    throw new Error(
      "provider replay receipt does not match its canonical request authority"
    );
  }
  return receipt;
}
