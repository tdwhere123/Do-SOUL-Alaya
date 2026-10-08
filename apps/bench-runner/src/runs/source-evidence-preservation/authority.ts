import { createHash } from "node:crypto";
import { z } from "zod";
import { isStepSemanticRequestProfile, AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { ExtractionTransportProvenanceSchema } from "../extraction/transport-route.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { StepQuoteBasisSchema, assertStepQuoteRates, stepQuoteBasisForDigest } from "../extraction/authority/step-quote.js";
import {
  ExtractionTargetRootBindingSchema, assertExtractionTargetRootBinding, canonicalExtractionTargetRoot,
  initializeExtractionTargetRoot, inspectExtractionTargetRoot
} from "../extraction/authority/target-root-binding.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { estimatedSemanticProviderUpperUsd } from "../provider-request/request-binding.js";
import { SOURCE_EVIDENCE_PRESERVATION_KIND, type SourceEvidencePreservationLine } from "./input.js";

export const SOURCE_EVIDENCE_PRESERVATION_AUTHORITY_CONTRACT = "source-evidence-preservation-authority-v1" as const;
export const SOURCE_EVIDENCE_PRESERVATION_PREFLIGHT_CONTRACT = "source-evidence-preservation-preflight-v1" as const;
export const SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY = 1 as const;
const executionRootMarker = Object.freeze({
  filename: ".source-evidence-preservation-execution-root.json",
  kind: "source-evidence-preservation-execution-root-v1"
});

const ExecutionScopeSchema = z.object({
  execution_root_path: z.string().min(1),
  execution_root_binding: ExtractionTargetRootBindingSchema.nullable(),
  implementation_revision: z.string().min(1)
}).strict();

const AuthoritySchema = z.object({
  contract: z.literal(SOURCE_EVIDENCE_PRESERVATION_AUTHORITY_CONTRACT),
  action: z.literal("fill"),
  kind: z.literal(SOURCE_EVIDENCE_PRESERVATION_KIND),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  execution_scope: ExecutionScopeSchema.extend({ execution_root_binding: ExtractionTargetRootBindingSchema }),
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  material_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  generated_at: z.string().min(1),
  identity_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  limits: z.object({
    starting_missing: z.number().int().nonnegative(),
    maximum_attempts_per_key: z.literal(SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY),
    maximum_attempts: z.number().int().nonnegative(),
    successful_shard_ceiling: z.number().int().nonnegative(),
    max_concurrency: z.literal(1),
    max_output_tokens: z.number().int().positive(),
    output_token_field: z.enum(["maxOutputTokens", "max_tokens"])
  }).strict(),
  price: z.object({
    input_usd_per_million: z.number().nonnegative(),
    output_usd_per_million: z.number().nonnegative(),
    maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
    estimated_upper_usd: z.number().nonnegative(),
    quote_basis: StepQuoteBasisSchema.optional()
  }).strict(),
  keys: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).readonly()
}).strict();

export type SourceEvidencePreservationAuthority = z.infer<typeof AuthoritySchema>;

const PreflightSchema = z.object({
  contract: z.literal(SOURCE_EVIDENCE_PRESERVATION_PREFLIGHT_CONTRACT),
  kind: z.literal(SOURCE_EVIDENCE_PRESERVATION_KIND),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  execution_scope: ExecutionScopeSchema,
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  material_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  provider_calls: z.literal(0),
  missing: z.number().int().nonnegative(),
  maximum_attempts_per_key: z.literal(SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY),
  maximum_attempts: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().positive(),
  maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
  quote_basis: StepQuoteBasisSchema.optional(),
  keys: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).readonly()
}).strict();

export type SourceEvidencePreservationPreflight = z.infer<typeof PreflightSchema>;

export function inspectSourceEvidencePreservationExecutionScope(
  cacheRoot: string
): SourceEvidencePreservationPreflight["execution_scope"] {
  return {
    execution_root_path: canonicalExtractionTargetRoot(cacheRoot),
    execution_root_binding: inspectExtractionTargetRoot({
      cacheRoot, marker: executionRootMarker, purpose: "evidence preservation"
    }),
    implementation_revision: readCurrentExtractionAuthorityRevision()
  };
}

export function assertSourceEvidencePreservationExecutionScope(
  scope: SourceEvidencePreservationAuthority["execution_scope"],
  cacheRoot: string,
  writeLease?: ExtractionCacheWriteLease
): void {
  if (scope.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "evidence preservation executable revision changed");
  }
  writeLease?.assertRoot(cacheRoot);
  const namedRoot = writeLease?.cacheRoot ?? cacheRoot;
  if (canonicalExtractionTargetRoot(namedRoot) !== scope.execution_root_path) {
    throw new AlayaError("CONFLICT", "evidence preservation execution root differs from authorized root");
  }
  assertExtractionTargetRootBinding({
    cacheRoot: namedRoot, marker: executionRootMarker, purpose: "evidence preservation",
    binding: scope.execution_root_binding, ...(writeLease === undefined ? {} : { writeLease })
  });
}

export function parseSourceEvidencePreservationPreflight(value: unknown): SourceEvidencePreservationPreflight {
  const preflight = PreflightSchema.parse(value);
  assertPreservationQuote(preflight);
  return preflight;
}

export function buildSourceEvidencePreservationPreflight(input: Readonly<{
  model: string;
  request_profile: string;
  maxOutputTokens: number;
  lines: readonly SourceEvidencePreservationLine[];
  cachedKeys: ReadonlySet<string>;
  executionScope: SourceEvidencePreservationPreflight["execution_scope"];
}>): SourceEvidencePreservationPreflight {
  const missingLines = input.lines.filter((line) => !input.cachedKeys.has(line.key));
  const maxInput = missingLines.reduce((max, line) => Math.max(max, line.inputByteUpper), 0);
  const transport = input.lines[0]?.transportProvenance;
  if (transport === undefined ||
      input.lines.some((line) => canonicalJson(line.transportProvenance) !== canonicalJson(transport))) {
    throw new AlayaError("VALIDATION", "evidence preservation preflight requires one resolved transport route");
  }
  const materialDigest = preservationMaterialDigest(input.lines);
  const preflight = {
    contract: SOURCE_EVIDENCE_PRESERVATION_PREFLIGHT_CONTRACT,
    kind: SOURCE_EVIDENCE_PRESERVATION_KIND,
    model: input.model,
    request_profile: input.request_profile,
    transport_provenance: transport,
    execution_scope: ExecutionScopeSchema.parse(input.executionScope),
    attempt_lineage_digest: sourceEvidencePreservationAttemptLineage({
      model: input.model, request_profile: input.request_profile, transport_provenance: transport
    }),
    material_digest: materialDigest,
    provider_calls: 0 as const,
    missing: missingLines.length,
    maximum_attempts_per_key: SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY,
    maximum_attempts: missingLines.length * SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY,
    max_output_tokens: input.maxOutputTokens,
    maximum_input_tokens_per_attempt: maxInput,
    ...(isStepSemanticRequestProfile(input.request_profile) ? {
      quote_basis: stepQuoteBasisForDigest(transport.model, transport.provider_url_sha256.slice("sha256:".length))
    } : {}),
    keys: missingLines.map((line) => line.key)
  };
  assertPreservationQuote(preflight);
  return PreflightSchema.parse(preflight);
}

export function quoteSourceEvidencePreservation(
  preflight: Pick<SourceEvidencePreservationPreflight, "maximum_attempts" | "max_output_tokens" | "maximum_input_tokens_per_attempt">,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number
): number {
  return estimatedSemanticProviderUpperUsd(preflight, inputUsdPerMillion, outputUsdPerMillion);
}

export function pinSourceEvidencePreservationAuthority(input: Readonly<{
  preflight: SourceEvidencePreservationPreflight;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  spendCeilingUsd?: number;
}>): SourceEvidencePreservationAuthority {
  const preflight = PreflightSchema.parse(input.preflight);
  assertPreservationQuote(preflight);
  assertStepQuoteRates(preflight.request_profile, input.inputUsdPerMillion, input.outputUsdPerMillion,
    preflight.quote_basis);
  if (preflight.execution_scope.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "evidence preservation executable revision changed since preflight");
  }
  const estimated = quoteSourceEvidencePreservation(preflight, input.inputUsdPerMillion, input.outputUsdPerMillion);
  if (input.spendCeilingUsd !== undefined && estimated > input.spendCeilingUsd) {
    throw new AlayaError("CONFLICT", `evidence preservation receipt ${estimated} exceeds spend ceiling ${input.spendCeilingUsd}`);
  }
  const scope = preflight.execution_scope;
  const binding = scope.execution_root_binding;
  const executionScope = {
    ...scope,
    execution_root_binding: binding ?? initializeExtractionTargetRoot({
      cacheRoot: scope.execution_root_path, marker: executionRootMarker, purpose: "evidence preservation"
    })
  };
  assertSourceEvidencePreservationExecutionScope(executionScope, scope.execution_root_path);
  const body = {
    contract: SOURCE_EVIDENCE_PRESERVATION_AUTHORITY_CONTRACT,
    action: "fill" as const,
    kind: SOURCE_EVIDENCE_PRESERVATION_KIND,
    model: preflight.model,
    request_profile: preflight.request_profile,
    transport_provenance: preflight.transport_provenance,
    execution_scope: executionScope,
    attempt_lineage_digest: preflight.attempt_lineage_digest,
    material_digest: preflight.material_digest,
    generated_at: new Date().toISOString(),
    limits: {
      starting_missing: preflight.missing,
      maximum_attempts_per_key: SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY,
      maximum_attempts: preflight.maximum_attempts,
      successful_shard_ceiling: preflight.missing,
      max_concurrency: 1 as const,
      max_output_tokens: preflight.max_output_tokens,
      output_token_field: isStepSemanticRequestProfile(preflight.request_profile)
        ? "max_tokens" as const : "maxOutputTokens" as const
    },
    price: {
      input_usd_per_million: input.inputUsdPerMillion,
      output_usd_per_million: input.outputUsdPerMillion,
      maximum_input_tokens_per_attempt: preflight.maximum_input_tokens_per_attempt,
      estimated_upper_usd: estimated,
      ...(preflight.quote_basis === undefined ? {} : { quote_basis: preflight.quote_basis })
    },
    keys: preflight.keys
  };
  const identity_digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return AuthoritySchema.parse({ ...body, identity_digest });
}

export function verifySourceEvidencePreservationAuthority(
  authority: SourceEvidencePreservationAuthority
): SourceEvidencePreservationAuthority {
  authority = AuthoritySchema.parse(authority);
  assertPreservationQuote(authority);
  assertStepQuoteRates(
    authority.request_profile,
    authority.price.input_usd_per_million,
    authority.price.output_usd_per_million,
    authority.price.quote_basis
  );
  const { identity_digest, ...body } = authority;
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  if (digest !== identity_digest) {
    throw new AlayaError("CONFLICT", "evidence preservation authority identity digest is invalid");
  }
  if (authority.attempt_lineage_digest !== sourceEvidencePreservationAttemptLineage(authority)) {
    throw new AlayaError("CONFLICT", "evidence preservation attempt lineage does not bind its execution scope");
  }
  if (new Set(authority.keys).size !== authority.keys.length) {
    throw new AlayaError("CONFLICT", "evidence preservation authority keys are not unique");
  }
  if (authority.limits.starting_missing !== authority.keys.length ||
      authority.limits.successful_shard_ceiling !== authority.keys.length) {
    throw new AlayaError("CONFLICT", "evidence preservation authority key/cap relationship is invalid");
  }
  if (authority.limits.maximum_attempts !== authority.keys.length * SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY) {
    throw new AlayaError("CONFLICT", "evidence preservation authority maximum_attempts does not bind its keys");
  }
  const estimated = quoteSourceEvidencePreservation({
    maximum_attempts: authority.limits.maximum_attempts,
    max_output_tokens: authority.limits.max_output_tokens,
    maximum_input_tokens_per_attempt: authority.price.maximum_input_tokens_per_attempt
  }, authority.price.input_usd_per_million, authority.price.output_usd_per_million);
  if (authority.price.estimated_upper_usd !== estimated) {
    throw new AlayaError("CONFLICT", "evidence preservation authority price does not bind its limits");
  }
  return authority;
}

export function sourceEvidencePreservationAttemptLineage(input: Pick<SourceEvidencePreservationAuthority,
  "model" | "request_profile" | "transport_provenance">): string {
  return createHash("sha256").update(canonicalJson({
    contract: "source-evidence-preservation-execution-lineage-v1",
    kind: SOURCE_EVIDENCE_PRESERVATION_KIND,
    model: input.model,
    request_profile: input.request_profile,
    transport_provenance: input.transport_provenance
  })).digest("hex");
}

function preservationMaterialDigest(lines: readonly SourceEvidencePreservationLine[]): string {
  return createHash("sha256").update(canonicalJson(lines.map((line) => ({
    key: line.key,
    material_digest: line.materialDigest
  })))).digest("hex");
}

function assertPreservationQuote(input: SourceEvidencePreservationPreflight | SourceEvidencePreservationAuthority): void {
  const step = isStepSemanticRequestProfile(input.request_profile);
  const quote = "price" in input ? input.price.quote_basis : input.quote_basis;
  const attempts = "price" in input ? input.limits.maximum_attempts_per_key : input.maximum_attempts_per_key;
  if (attempts !== SOURCE_EVIDENCE_PRESERVATION_ATTEMPTS_PER_KEY) {
    throw new AlayaError("CONFLICT", "evidence preservation requires one attempt per key");
  }
  if ("price" in input && input.limits.output_token_field !== (step ? "max_tokens" : "maxOutputTokens")) {
    throw new AlayaError("CONFLICT", "evidence preservation profile/output field mismatch");
  }
  if (!step) {
    if (quote !== undefined) throw new AlayaError("CONFLICT", "Gemini evidence preservation has a Step quote");
    return;
  }
  const expected = stepQuoteBasisForDigest(
    input.transport_provenance.model,
    input.transport_provenance.provider_url_sha256.slice("sha256:".length)
  );
  if (canonicalJson(StepQuoteBasisSchema.parse(quote)) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "evidence preservation quote differs from its route");
  }
}
