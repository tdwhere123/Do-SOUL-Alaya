import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { SemanticProposalKind, SemanticProposalLine } from "./workset.js";
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

export const SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT = "source-semantic-proposal-authority-v5" as const;
export const STEP_SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT = "source-semantic-proposal-authority-v6" as const;
export const DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY = 2;
const AttemptsPerKeySchema = z.number().int().min(1).max(DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY);
const executionRootMarker = Object.freeze({ filename: ".semantic-proposal-execution-root.json",
  kind: "semantic-proposal-execution-root-v1" });
const ExecutionScopeSchema = z.object({
  execution_root_path: z.string().min(1),
  execution_root_binding: ExtractionTargetRootBindingSchema.nullable(),
  implementation_revision: z.string().min(1)
}).strict();

const AuthoritySchema = z.object({
  contract: z.enum([SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT, STEP_SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT]),
  action: z.literal("fill"),
  kind: z.enum(["query", "semantic_correspondence"]),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  execution_scope: ExecutionScopeSchema.extend({ execution_root_binding: ExtractionTargetRootBindingSchema }),
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

export type SemanticProposalAuthority = z.infer<typeof AuthoritySchema>;

const PreflightSchema = z.object({
  contract: z.enum(["source-semantic-proposal-preflight-v5", "source-semantic-proposal-preflight-v6"]),
  kind: z.enum(["query", "semantic_correspondence"]),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  transport_provenance: ExtractionTransportProvenanceSchema,
  execution_scope: ExecutionScopeSchema,
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  provider_calls: z.literal(0),
  missing: z.number().int().nonnegative(),
  maximum_attempts_per_key: AttemptsPerKeySchema,
  maximum_attempts: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().positive(),
  maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
  quote_basis: StepQuoteBasisSchema.optional(),
  keys: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).readonly()
}).strict();

export type SemanticProposalPreflight = z.infer<typeof PreflightSchema>;

/** Read-only preparation also serves callers rebuilding a frozen preflight for validation. */
export function inspectSemanticProposalExecutionScope(cacheRoot: string): SemanticProposalPreflight["execution_scope"] {
  return {
    execution_root_path: canonicalExtractionTargetRoot(cacheRoot),
    execution_root_binding: inspectExtractionTargetRoot({ cacheRoot, marker: executionRootMarker, purpose: "semantic proposal" }),
    implementation_revision: readCurrentExtractionAuthorityRevision()
  };
}

export function assertSemanticProposalExecutionScope(
  scope: SemanticProposalAuthority["execution_scope"], cacheRoot: string, writeLease?: ExtractionCacheWriteLease
): void {
  if (scope.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "semantic proposal executable revision changed");
  }
  writeLease?.assertRoot(cacheRoot);
  const namedRoot = writeLease?.cacheRoot ?? cacheRoot;
  if (canonicalExtractionTargetRoot(namedRoot) !== scope.execution_root_path) {
    throw new AlayaError("CONFLICT", "semantic proposal execution root differs from authorized root");
  }
  assertExtractionTargetRootBinding({ cacheRoot: namedRoot, marker: executionRootMarker, purpose: "semantic proposal",
    binding: scope.execution_root_binding, ...(writeLease === undefined ? {} : { writeLease }) });
}

export function parseSemanticProposalPreflight(value: unknown): SemanticProposalPreflight {
  const preflight = PreflightSchema.parse(value);
  assertProposalQuote(preflight);
  return preflight;
}

export function buildSemanticProposalPreflight(input: Readonly<{
  kind: SemanticProposalKind;
  model: string;
  request_profile: string;
  maxOutputTokens: number;
  maxAttemptsPerKey?: number;
  lines: readonly SemanticProposalLine[];
  cachedKeys: ReadonlySet<string>;
  executionScope: SemanticProposalPreflight["execution_scope"];
}>): SemanticProposalPreflight {
  const missingLines = input.lines.filter((line) => !input.cachedKeys.has(line.key));
  const attemptsPerKey = AttemptsPerKeySchema.parse(input.maxAttemptsPerKey ?? DEFAULT_SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY);
  if (input.request_profile === STEP_SEMANTIC_REQUEST_PROFILE && attemptsPerKey !== 1) {
    throw new AlayaError("VALIDATION", "Step proposal preflight requires one attempt per key");
  }
  const maxInput = missingLines.reduce((max, line) => Math.max(max, line.inputByteUpper), 0);
  const transport = input.lines[0]?.transportProvenance;
  if (transport === undefined || input.lines.some(line => canonicalJson(line.transportProvenance) !== canonicalJson(transport))) {
    throw new AlayaError("VALIDATION", "semantic proposal preflight requires one resolved transport route");
  }
  return {
    contract: input.request_profile === STEP_SEMANTIC_REQUEST_PROFILE
      ? "source-semantic-proposal-preflight-v6" : "source-semantic-proposal-preflight-v5",
    kind: input.kind, model: input.model, request_profile: input.request_profile,
    transport_provenance: transport,
    execution_scope: ExecutionScopeSchema.parse(input.executionScope),
    attempt_lineage_digest: proposalAttemptLineage({ ...input, transport_provenance: transport }),
    provider_calls: 0, missing: missingLines.length,
    maximum_attempts_per_key: attemptsPerKey,
    maximum_attempts: missingLines.length * attemptsPerKey,
    max_output_tokens: input.maxOutputTokens,
    maximum_input_tokens_per_attempt: maxInput,
    ...(input.request_profile === STEP_SEMANTIC_REQUEST_PROFILE ? {
      quote_basis: stepQuoteBasisForDigest(transport.model, transport.provider_url_sha256.slice("sha256:".length))
    } : {}),
    keys: missingLines.map((line) => line.key)
  };
}

export function pinSemanticProposalAuthority(input: Readonly<{
  preflight: SemanticProposalPreflight;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  spendCeilingUsd?: number;
}>): SemanticProposalAuthority {
  const preflight = PreflightSchema.parse(input.preflight);
  assertProposalQuote(preflight);
  assertStepQuoteRates(preflight.request_profile, input.inputUsdPerMillion, input.outputUsdPerMillion,
    preflight.quote_basis);
  if (preflight.execution_scope.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "semantic proposal executable revision changed since preflight");
  }
  const estimated = estimatedUpperUsd(input.preflight, input.inputUsdPerMillion, input.outputUsdPerMillion);
  if (input.spendCeilingUsd !== undefined && estimated > input.spendCeilingUsd) {
    throw new AlayaError("CONFLICT", `semantic proposal receipt ${estimated} exceeds spend ceiling ${input.spendCeilingUsd}`);
  }
  const scope = preflight.execution_scope;
  const binding = scope.execution_root_binding;
  const executionScope = { ...scope, execution_root_binding: binding ?? initializeExtractionTargetRoot({
    cacheRoot: scope.execution_root_path, marker: executionRootMarker, purpose: "semantic proposal"
  }) };
  assertSemanticProposalExecutionScope(executionScope, scope.execution_root_path);
  const body = {
    contract: preflight.request_profile === STEP_SEMANTIC_REQUEST_PROFILE
      ? STEP_SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT : SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT,
    action: "fill" as const,
    kind: input.preflight.kind, model: input.preflight.model, request_profile: input.preflight.request_profile,
    transport_provenance: input.preflight.transport_provenance,
    execution_scope: executionScope,
    attempt_lineage_digest: input.preflight.attempt_lineage_digest,
    generated_at: new Date().toISOString(),
    limits: {
      starting_missing: input.preflight.missing,
      maximum_attempts_per_key: input.preflight.maximum_attempts_per_key,
      maximum_attempts: input.preflight.maximum_attempts,
      successful_shard_ceiling: input.preflight.missing,
      max_concurrency: 1 as const,
      max_output_tokens: input.preflight.max_output_tokens,
      output_token_field: preflight.request_profile === STEP_SEMANTIC_REQUEST_PROFILE
        ? "max_tokens" as const : "maxOutputTokens" as const
    },
    price: {
      input_usd_per_million: input.inputUsdPerMillion,
      output_usd_per_million: input.outputUsdPerMillion,
      maximum_input_tokens_per_attempt: input.preflight.maximum_input_tokens_per_attempt,
      estimated_upper_usd: estimated,
      ...(preflight.quote_basis === undefined ? {} : { quote_basis: preflight.quote_basis })
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
  return estimatedSemanticProviderUpperUsd(preflight, inputUsdPerMillion, outputUsdPerMillion);
}

export function verifySemanticProposalAuthority(authority: SemanticProposalAuthority): SemanticProposalAuthority {
  authority = AuthoritySchema.parse(authority);
  assertProposalQuote(authority);
  assertStepQuoteRates(authority.request_profile,
    authority.price.input_usd_per_million, authority.price.output_usd_per_million,
    authority.price.quote_basis);
  const { identity_digest, ...body } = authority;
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  if (digest !== identity_digest) {
    throw new AlayaError("CONFLICT", "semantic proposal authority identity digest is invalid");
  }
  if (authority.attempt_lineage_digest !== proposalAttemptLineage(authority)) {
    throw new AlayaError("CONFLICT", "semantic proposal attempt lineage does not bind its execution scope");
  }
  if (new Set(authority.keys).size !== authority.keys.length) {
    throw new AlayaError("CONFLICT", "semantic proposal authority keys are not unique");
  }
  if (authority.limits.starting_missing !== authority.keys.length ||
      authority.limits.successful_shard_ceiling !== authority.keys.length) {
    throw new AlayaError("CONFLICT", "semantic proposal authority key/cap relationship is invalid");
  }
  if (authority.limits.maximum_attempts !== authority.keys.length * authority.limits.maximum_attempts_per_key) {
    throw new AlayaError("CONFLICT", "semantic proposal authority maximum_attempts does not bind its keys");
  }
  const estimated = estimatedUpperUsd({
    maximum_attempts: authority.limits.maximum_attempts,
    max_output_tokens: authority.limits.max_output_tokens,
    maximum_input_tokens_per_attempt: authority.price.maximum_input_tokens_per_attempt
  }, authority.price.input_usd_per_million, authority.price.output_usd_per_million);
  if (authority.price.estimated_upper_usd !== estimated) {
    throw new AlayaError("CONFLICT", "semantic proposal authority price does not bind its limits");
  }
  return authority;
}

function assertProposalQuote(input: SemanticProposalPreflight | SemanticProposalAuthority): void {
  const step = input.request_profile === STEP_SEMANTIC_REQUEST_PROFILE;
  const quote = "price" in input ? input.price.quote_basis : input.quote_basis;
  const expectedContract = "price" in input ? STEP_SEMANTIC_PROPOSAL_AUTHORITY_CONTRACT :
    "source-semantic-proposal-preflight-v6";
  if (step !== (input.contract === expectedContract) ||
      "price" in input && input.limits.output_token_field !== (step ? "max_tokens" : "maxOutputTokens") ||
      step && ("price" in input ? input.limits.maximum_attempts_per_key : input.maximum_attempts_per_key) !== 1) {
    throw new AlayaError("CONFLICT", "semantic proposal profile/contract/output field mismatch");
  }
  if (!step) {
    if (quote !== undefined) throw new AlayaError("CONFLICT", "Gemini proposal has a Step quote");
    return;
  }
  const expected = stepQuoteBasisForDigest(input.transport_provenance.model,
    input.transport_provenance.provider_url_sha256.slice("sha256:".length));
  if (canonicalJson(StepQuoteBasisSchema.parse(quote)) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "semantic proposal quote differs from its route");
  }
}

/** Revision, root binding and receipt identity never renew this ledger's attempts. */
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
