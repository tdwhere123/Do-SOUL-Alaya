import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "@do-soul/alaya-protocol";
import type { SemanticProposalKind, SemanticProposalLine } from "./workset.js";
import { ExtractionTransportProvenanceSchema } from "../extraction/transport-route.js";

export const SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT = "source-semantic-proposal-authority-v4" as const;
export const DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY = 2;
const MILLION = 1_000_000;
const AttemptsPerKeySchema = z.number().int().min(1).max(DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY);

const AuthoritySchema = z.object({
  contract: z.literal(SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT),
  action: z.literal("fill"),
  kind: z.enum(["query", "semantic_correspondence"]),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  generated_at: z.string().min(1),
  identity_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  limits: z.object({
    starting_missing: z.number().int().nonnegative(),
    maximum_attempts_per_key: AttemptsPerKeySchema,
    maximum_attempts: z.number().int().nonnegative(),
    successful_shard_ceiling: z.number().int().nonnegative(),
    max_concurrency: z.literal(1),
    max_output_tokens: z.number().int().positive(),
    output_token_field: z.literal("maxOutputTokens")
  }).strict(),
  price: z.object({
    input_usd_per_million: z.number().nonnegative(),
    output_usd_per_million: z.number().nonnegative(),
    maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
    estimated_upper_usd: z.number().nonnegative()
  }).strict(),
  keys: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).readonly()
}).strict();

export type SemanticProposalAuthority = z.infer<typeof AuthoritySchema>;

const PreflightSchema = z.object({
  contract: z.literal("source-semantic-proposal-preflight-v4"),
  kind: z.enum(["query", "semantic_correspondence"]),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  provider_calls: z.literal(0),
  missing: z.number().int().nonnegative(),
  maximum_attempts_per_key: AttemptsPerKeySchema,
  maximum_attempts: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().positive(),
  maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
  keys: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).readonly()
}).strict();

export type SemanticProposalPreflight = z.infer<typeof PreflightSchema>;

export function parseSemanticProposalPreflight(value: unknown): SemanticProposalPreflight {
  return PreflightSchema.parse(value);
}

export function buildSemanticProposalPreflight(input: Readonly<{
  kind: SemanticProposalKind;
  model: string;
  request_profile: string;
  maxOutputTokens: number;
  maxAttemptsPerKey?: number;
  lines: readonly SemanticProposalLine[];
  cachedKeys: ReadonlySet<string>;
}>): SemanticProposalPreflight {
  const missingLines = input.lines.filter((line) => !input.cachedKeys.has(line.key));
  const attemptsPerKey = AttemptsPerKeySchema.parse(input.maxAttemptsPerKey ?? DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY);
  const maxInput = missingLines.reduce((max, line) => Math.max(max, line.inputByteUpper), 0);
  const transport = input.lines[0]?.transportProvenance;
  if (transport === undefined || input.lines.some(line => canonicalJson(line.transportProvenance) !== canonicalJson(transport))) {
    throw new Error("semantic proposal preflight requires one resolved transport route");
  }
  return {
    contract: "source-semantic-proposal-preflight-v4",
    kind: input.kind, model: input.model, request_profile: input.request_profile,
    transport_provenance: transport,
    attempt_lineage_digest: proposalAttemptLineage({ ...input, transport_provenance: transport }),
    provider_calls: 0, missing: missingLines.length,
    maximum_attempts_per_key: attemptsPerKey,
    maximum_attempts: missingLines.length * attemptsPerKey,
    max_output_tokens: input.maxOutputTokens,
    maximum_input_tokens_per_attempt: maxInput,
    keys: missingLines.map((line) => line.key)
  };
}

export function pinSemanticProposalAuthority(input: Readonly<{
  preflight: SemanticProposalPreflight;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  spendCeilingUsd?: number;
}>): SemanticProposalAuthority {
  const estimated = estimatedUpperUsd(input.preflight, input.inputUsdPerMillion, input.outputUsdPerMillion);
  if (input.spendCeilingUsd !== undefined && estimated > input.spendCeilingUsd) {
    throw new Error(`semantic proposal receipt ${estimated} exceeds spend ceiling ${input.spendCeilingUsd}`);
  }
  const body = {
    contract: SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT, action: "fill" as const,
    kind: input.preflight.kind, model: input.preflight.model, request_profile: input.preflight.request_profile,
    transport_provenance: input.preflight.transport_provenance,
    attempt_lineage_digest: input.preflight.attempt_lineage_digest,
    generated_at: new Date().toISOString(),
    limits: {
      starting_missing: input.preflight.missing,
      maximum_attempts_per_key: input.preflight.maximum_attempts_per_key,
      maximum_attempts: input.preflight.maximum_attempts,
      successful_shard_ceiling: input.preflight.missing,
      max_concurrency: 1 as const,
      max_output_tokens: input.preflight.max_output_tokens,
      output_token_field: "maxOutputTokens" as const
    },
    price: {
      input_usd_per_million: input.inputUsdPerMillion,
      output_usd_per_million: input.outputUsdPerMillion,
      maximum_input_tokens_per_attempt: input.preflight.maximum_input_tokens_per_attempt,
      estimated_upper_usd: estimated
    },
    keys: input.preflight.keys
  };
  const identity_digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return AuthoritySchema.parse({ ...body, identity_digest });
}

export function estimatedUpperUsd(
  preflight: Pick<SemanticProposalPreflight, "maximum_attempts" | "max_output_tokens" | "maximum_input_tokens_per_attempt">,
  inputUsdPerMillion: number, outputUsdPerMillion: number
): number {
  const perAttempt = (
    preflight.maximum_input_tokens_per_attempt * inputUsdPerMillion +
    preflight.max_output_tokens * outputUsdPerMillion
  ) / MILLION;
  return perAttempt * preflight.maximum_attempts;
}

export function verifySemanticProposalAuthority(authority: SemanticProposalAuthority): SemanticProposalAuthority {
  authority = AuthoritySchema.parse(authority);
  const { identity_digest, ...body } = authority;
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  if (digest !== identity_digest) {
    throw new Error("semantic proposal authority identity digest is invalid");
  }
  if (authority.attempt_lineage_digest !== proposalAttemptLineage(authority)) {
    throw new Error("semantic proposal attempt lineage does not bind its execution scope");
  }
  if (new Set(authority.keys).size !== authority.keys.length) {
    throw new Error("semantic proposal authority keys are not unique");
  }
  if (authority.limits.starting_missing !== authority.keys.length ||
      authority.limits.successful_shard_ceiling !== authority.keys.length) {
    throw new Error("semantic proposal authority key/cap relationship is invalid");
  }
  if (authority.limits.maximum_attempts !== authority.keys.length * authority.limits.maximum_attempts_per_key) {
    throw new Error("semantic proposal authority maximum_attempts does not bind its keys");
  }
  const estimated = estimatedUpperUsd({
    maximum_attempts: authority.limits.maximum_attempts,
    max_output_tokens: authority.limits.max_output_tokens,
    maximum_input_tokens_per_attempt: authority.price.maximum_input_tokens_per_attempt
  }, authority.price.input_usd_per_million, authority.price.output_usd_per_million);
  if (authority.price.estimated_upper_usd !== estimated) {
    throw new Error("semantic proposal authority price does not bind its limits");
  }
  return authority;
}

/** Re-pinning a grant resumes the same bounded execution; it cannot renew its attempts. */
export function proposalAttemptLineage(input: Pick<SemanticProposalAuthority,
  "kind" | "model" | "request_profile" | "transport_provenance">): string {
  return createHash("sha256").update(canonicalJson({ contract: "semantic-proposal-execution-lineage-v1",
    kind: input.kind, model: input.model, request_profile: input.request_profile,
    transport_provenance: input.transport_provenance })).digest("hex");
}

export function readSemanticProposalAuthority(path: string): SemanticProposalAuthority {
  return verifySemanticProposalAuthority(AuthoritySchema.parse(JSON.parse(readFileSync(path, "utf8"))));
}

export function writeJsonExclusive(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
