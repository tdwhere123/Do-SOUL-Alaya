import { createHash } from "node:crypto";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { ExtractionTransportProvenanceSchema } from "../extraction/transport-route.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { StepQuoteBasisSchema, assertStepQuoteRates, stepQuoteBasisForDigest } from "../extraction/authority/step-quote.js";
import { STEP_SEMANTIC_REQUEST_PROFILE } from "../compile-seed/http/semantic-provider-http.js";
import {
  ExtractionTargetRootBindingSchema, assertExtractionTargetRootBinding, canonicalExtractionTargetRoot,
  initializeExtractionTargetRoot, inspectExtractionTargetRoot
} from "../extraction/authority/target-root-binding.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { estimatedSemanticProviderUpperUsd } from "../provider-request/request-binding.js";
import { EVIDENCE_SELECTION_KIND, type EvidenceSelectionLine } from "./input.js";

export const EVIDENCE_SELECTION_AUTHORITY_CONTRACT = "source-evidence-selection-authority-v1" as const;
export const EVIDENCE_SELECTION_PREFLIGHT_CONTRACT = "source-evidence-selection-preflight-v1" as const;
export const EVIDENCE_SELECTION_ATTEMPTS_PER_KEY = 1 as const;
const executionRootMarker = Object.freeze({
  filename: ".source-evidence-selection-execution-root.json",
  kind: "source-evidence-selection-execution-root-v1"
});

const ExecutionScopeSchema = z.object({
  execution_root_path: z.string().min(1),
  execution_root_binding: ExtractionTargetRootBindingSchema.nullable(),
  implementation_revision: z.string().min(1)
}).strict();

const AuthoritySchema = z.object({
  contract: z.literal(EVIDENCE_SELECTION_AUTHORITY_CONTRACT),
  action: z.literal("fill"),
  kind: z.literal(EVIDENCE_SELECTION_KIND),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  execution_scope: ExecutionScopeSchema.extend({ execution_root_binding: ExtractionTargetRootBindingSchema }),
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  sources_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  generated_at: z.string().min(1),
  identity_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  limits: z.object({
    starting_missing: z.number().int().nonnegative(),
    maximum_attempts_per_key: z.literal(EVIDENCE_SELECTION_ATTEMPTS_PER_KEY),
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

export type EvidenceSelectionAuthority = z.infer<typeof AuthoritySchema>;

const PreflightSchema = z.object({
  contract: z.literal(EVIDENCE_SELECTION_PREFLIGHT_CONTRACT),
  kind: z.literal(EVIDENCE_SELECTION_KIND),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  execution_scope: ExecutionScopeSchema,
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  sources_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  provider_calls: z.literal(0),
  missing: z.number().int().nonnegative(),
  maximum_attempts_per_key: z.literal(EVIDENCE_SELECTION_ATTEMPTS_PER_KEY),
  maximum_attempts: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().positive(),
  maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
  quote_basis: StepQuoteBasisSchema.optional(),
  keys: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).readonly()
}).strict();

export type EvidenceSelectionPreflight = z.infer<typeof PreflightSchema>;

export function inspectEvidenceSelectionExecutionScope(
  cacheRoot: string
): EvidenceSelectionPreflight["execution_scope"] {
  return {
    execution_root_path: canonicalExtractionTargetRoot(cacheRoot),
    execution_root_binding: inspectExtractionTargetRoot({
      cacheRoot, marker: executionRootMarker, purpose: "evidence selection"
    }),
    implementation_revision: readCurrentExtractionAuthorityRevision()
  };
}

export function assertEvidenceSelectionExecutionScope(
  scope: EvidenceSelectionAuthority["execution_scope"],
  cacheRoot: string,
  writeLease?: ExtractionCacheWriteLease
): void {
  if (scope.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "evidence selection executable revision changed");
  }
  writeLease?.assertRoot(cacheRoot);
  const namedRoot = writeLease?.cacheRoot ?? cacheRoot;
  if (canonicalExtractionTargetRoot(namedRoot) !== scope.execution_root_path) {
    throw new AlayaError("CONFLICT", "evidence selection execution root differs from authorized root");
  }
  assertExtractionTargetRootBinding({
    cacheRoot: namedRoot, marker: executionRootMarker, purpose: "evidence selection",
    binding: scope.execution_root_binding, ...(writeLease === undefined ? {} : { writeLease })
  });
}

export function parseEvidenceSelectionPreflight(value: unknown): EvidenceSelectionPreflight {
  const preflight = PreflightSchema.parse(value);
  assertSelectionQuote(preflight);
  return preflight;
}

export function buildEvidenceSelectionPreflight(input: Readonly<{
  model: string;
  request_profile: string;
  maxOutputTokens: number;
  lines: readonly EvidenceSelectionLine[];
  cachedKeys: ReadonlySet<string>;
  executionScope: EvidenceSelectionPreflight["execution_scope"];
}>): EvidenceSelectionPreflight {
  const missingLines = input.lines.filter((line) => !input.cachedKeys.has(line.key));
  const maxInput = missingLines.reduce((max, line) => Math.max(max, line.inputByteUpper), 0);
  const transport = input.lines[0]?.transportProvenance;
  if (transport === undefined ||
      input.lines.some((line) => canonicalJson(line.transportProvenance) !== canonicalJson(transport))) {
    throw new AlayaError("VALIDATION", "evidence selection preflight requires one resolved transport route");
  }
  const sourcesDigest = selectionSourcesDigest(input.lines);
  const preflight = {
    contract: EVIDENCE_SELECTION_PREFLIGHT_CONTRACT,
    kind: EVIDENCE_SELECTION_KIND,
    model: input.model,
    request_profile: input.request_profile,
    transport_provenance: transport,
    execution_scope: ExecutionScopeSchema.parse(input.executionScope),
    attempt_lineage_digest: evidenceSelectionAttemptLineage({
      model: input.model, request_profile: input.request_profile, transport_provenance: transport
    }),
    sources_digest: sourcesDigest,
    provider_calls: 0 as const,
    missing: missingLines.length,
    maximum_attempts_per_key: EVIDENCE_SELECTION_ATTEMPTS_PER_KEY,
    maximum_attempts: missingLines.length * EVIDENCE_SELECTION_ATTEMPTS_PER_KEY,
    max_output_tokens: input.maxOutputTokens,
    maximum_input_tokens_per_attempt: maxInput,
    ...(input.request_profile === STEP_SEMANTIC_REQUEST_PROFILE ? {
      quote_basis: stepQuoteBasisForDigest(transport.model, transport.provider_url_sha256.slice("sha256:".length))
    } : {}),
    keys: missingLines.map((line) => line.key)
  };
  assertSelectionQuote(preflight);
  return PreflightSchema.parse(preflight);
}

/** Native conservative upper from the owned byte bound and explicit rates. */
export function quoteEvidenceSelection(
  preflight: Pick<EvidenceSelectionPreflight, "maximum_attempts" | "max_output_tokens" | "maximum_input_tokens_per_attempt">,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number
): number {
  return estimatedSemanticProviderUpperUsd(preflight, inputUsdPerMillion, outputUsdPerMillion);
}

export function pinEvidenceSelectionAuthority(input: Readonly<{
  preflight: EvidenceSelectionPreflight;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  spendCeilingUsd?: number;
}>): EvidenceSelectionAuthority {
  const preflight = PreflightSchema.parse(input.preflight);
  assertSelectionQuote(preflight);
  assertStepQuoteRates(preflight.request_profile, input.inputUsdPerMillion, input.outputUsdPerMillion,
    preflight.quote_basis);
  if (preflight.execution_scope.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "evidence selection executable revision changed since preflight");
  }
  const estimated = quoteEvidenceSelection(preflight, input.inputUsdPerMillion, input.outputUsdPerMillion);
  if (input.spendCeilingUsd !== undefined && estimated > input.spendCeilingUsd) {
    throw new AlayaError("CONFLICT", `evidence selection receipt ${estimated} exceeds spend ceiling ${input.spendCeilingUsd}`);
  }
  const scope = preflight.execution_scope;
  const binding = scope.execution_root_binding;
  const executionScope = {
    ...scope,
    execution_root_binding: binding ?? initializeExtractionTargetRoot({
      cacheRoot: scope.execution_root_path, marker: executionRootMarker, purpose: "evidence selection"
    })
  };
  assertEvidenceSelectionExecutionScope(executionScope, scope.execution_root_path);
  const body = {
    contract: EVIDENCE_SELECTION_AUTHORITY_CONTRACT,
    action: "fill" as const,
    kind: EVIDENCE_SELECTION_KIND,
    model: preflight.model,
    request_profile: preflight.request_profile,
    transport_provenance: preflight.transport_provenance,
    execution_scope: executionScope,
    attempt_lineage_digest: preflight.attempt_lineage_digest,
    sources_digest: preflight.sources_digest,
    generated_at: new Date().toISOString(),
    limits: {
      starting_missing: preflight.missing,
      maximum_attempts_per_key: EVIDENCE_SELECTION_ATTEMPTS_PER_KEY,
      maximum_attempts: preflight.maximum_attempts,
      successful_shard_ceiling: preflight.missing,
      max_concurrency: 1 as const,
      max_output_tokens: preflight.max_output_tokens,
      output_token_field: preflight.request_profile === STEP_SEMANTIC_REQUEST_PROFILE
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

export function verifyEvidenceSelectionAuthority(
  authority: EvidenceSelectionAuthority
): EvidenceSelectionAuthority {
  authority = AuthoritySchema.parse(authority);
  assertSelectionQuote(authority);
  assertStepQuoteRates(
    authority.request_profile,
    authority.price.input_usd_per_million,
    authority.price.output_usd_per_million,
    authority.price.quote_basis
  );
  const { identity_digest, ...body } = authority;
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  if (digest !== identity_digest) {
    throw new AlayaError("CONFLICT", "evidence selection authority identity digest is invalid");
  }
  if (authority.attempt_lineage_digest !== evidenceSelectionAttemptLineage(authority)) {
    throw new AlayaError("CONFLICT", "evidence selection attempt lineage does not bind its execution scope");
  }
  if (new Set(authority.keys).size !== authority.keys.length) {
    throw new AlayaError("CONFLICT", "evidence selection authority keys are not unique");
  }
  if (authority.limits.starting_missing !== authority.keys.length ||
      authority.limits.successful_shard_ceiling !== authority.keys.length) {
    throw new AlayaError("CONFLICT", "evidence selection authority key/cap relationship is invalid");
  }
  if (authority.limits.maximum_attempts !== authority.keys.length * EVIDENCE_SELECTION_ATTEMPTS_PER_KEY) {
    throw new AlayaError("CONFLICT", "evidence selection authority maximum_attempts does not bind its keys");
  }
  const estimated = quoteEvidenceSelection({
    maximum_attempts: authority.limits.maximum_attempts,
    max_output_tokens: authority.limits.max_output_tokens,
    maximum_input_tokens_per_attempt: authority.price.maximum_input_tokens_per_attempt
  }, authority.price.input_usd_per_million, authority.price.output_usd_per_million);
  if (authority.price.estimated_upper_usd !== estimated) {
    throw new AlayaError("CONFLICT", "evidence selection authority price does not bind its limits");
  }
  return authority;
}

export function evidenceSelectionAttemptLineage(input: Pick<EvidenceSelectionAuthority,
  "model" | "request_profile" | "transport_provenance">): string {
  return createHash("sha256").update(canonicalJson({
    contract: "source-evidence-selection-execution-lineage-v1",
    kind: EVIDENCE_SELECTION_KIND,
    model: input.model,
    request_profile: input.request_profile,
    transport_provenance: input.transport_provenance
  })).digest("hex");
}

function selectionSourcesDigest(lines: readonly EvidenceSelectionLine[]): string {
  return createHash("sha256").update(canonicalJson(lines.map((line) => ({
    key: line.key,
    sources_digest: line.sourcesDigest
  })))).digest("hex");
}

function assertSelectionQuote(input: EvidenceSelectionPreflight | EvidenceSelectionAuthority): void {
  const step = input.request_profile === STEP_SEMANTIC_REQUEST_PROFILE;
  const quote = "price" in input ? input.price.quote_basis : input.quote_basis;
  const attempts = "price" in input ? input.limits.maximum_attempts_per_key : input.maximum_attempts_per_key;
  if (attempts !== EVIDENCE_SELECTION_ATTEMPTS_PER_KEY) {
    throw new AlayaError("CONFLICT", "evidence selection requires one attempt per key");
  }
  if ("price" in input && input.limits.output_token_field !== (step ? "max_tokens" : "maxOutputTokens")) {
    throw new AlayaError("CONFLICT", "evidence selection profile/output field mismatch");
  }
  if (!step) {
    if (quote !== undefined) throw new AlayaError("CONFLICT", "Gemini evidence selection has a Step quote");
    return;
  }
  const expected = stepQuoteBasisForDigest(
    input.transport_provenance.model,
    input.transport_provenance.provider_url_sha256.slice("sha256:".length)
  );
  if (canonicalJson(StepQuoteBasisSchema.parse(quote)) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "evidence selection quote differs from its route");
  }
}
