import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { chainIdentity, writeChainArtifact } from "../contract.js";
import { admitConsumerPreparation, ConsumerRequestTimeoutSchema, TASK_CONSUMER_KIND } from "./input.js";
import { readCurrentExtractionAuthorityRevision } from "../../extraction/authority/inspection.js";
import { StepQuoteBasisSchema, assertStepQuoteRates, stepQuoteBasisForDigest } from "../../extraction/authority/step-quote.js";
import { ExtractionTransportProvenanceSchema } from "../../extraction/transport-route.js";
import { estimatedSemanticProviderUpperUsd } from "../../provider-request/request-binding.js";
import { assertAttemptInputWithinReceiptLimit } from "../../extraction/authority/receipt-limits.js";
import {
  ExtractionTargetRootBindingSchema, assertExtractionTargetRootBinding, canonicalExtractionTargetRoot,
  initializeExtractionTargetRoot
} from "../../extraction/authority/target-root-binding.js";
import type { ExtractionCacheWriteLease } from "../../extraction/fill/manifest/fill-root-guard.js";

const ROOT_MARKER = { filename: ".task-consumer-execution-root.json", kind: "task-consumer-execution-root-v1" };
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const LimitsSchema = z.object({ maximum_attempts: z.number().int().min(1).max(2),
  maximum_attempts_per_key: z.literal(1), successful_shard_ceiling: z.number().int().min(1).max(2),
  max_concurrency: z.literal(1), max_output_tokens: z.number().int().min(1).max(65536),
  output_token_field: z.literal("max_tokens") }).strict();
export const ConsumerAuthoritySchema = z.object({
  contract: z.literal("semantic-chain-consumer-authority-v1"), kind: z.literal(TASK_CONSUMER_KIND),
  preparation_identity: Digest, attempt_lineage_digest: Digest, identity_digest: Digest,
  model: z.string().min(1), request_profile: z.string().min(1), transport_provenance: ExtractionTransportProvenanceSchema,
  request_timeout: ConsumerRequestTimeoutSchema,
  execution_scope: z.object({ preparation_root: z.string().min(1), execution_root_path: z.string().min(1),
    execution_root_binding: ExtractionTargetRootBindingSchema, implementation_revision: z.string().min(1) }).strict(),
  limits: LimitsSchema, keys: z.array(Digest).min(1).max(2),
  price: z.object({ input_usd_per_million: z.number().nonnegative(), output_usd_per_million: z.number().nonnegative(),
    maximum_input_tokens_per_attempt: z.number().int().nonnegative(), estimated_upper_usd: z.number().nonnegative(),
    spend_ceiling_usd: z.number().nonnegative(), quote_basis: StepQuoteBasisSchema }).strict()
}).strict();
export type ConsumerAuthority = z.infer<typeof ConsumerAuthoritySchema>;

/** Bind finite user-authorized work without reserving or executing a provider attempt. */
export function pinSemanticChainConsumerAuthority(input: Readonly<{
  preparationRoot: string; inputUsdPerMillion: number; outputUsdPerMillion: number; spendCeilingUsd: number;
}>): ConsumerAuthority {
  const current = admitConsumerPreparation(input.preparationRoot);
  const { preparation, lines } = current, config = preparation.consumer_config;
  const preparationIdentity = chainIdentity(preparation), transport = lines[0]!.transportProvenance;
  const quoteBasis = stepQuoteBasisForDigest(transport.model, transport.provider_url_sha256.slice("sha256:".length));
  assertStepQuoteRates(config.request_profile, input.inputUsdPerMillion, input.outputUsdPerMillion, quoteBasis);
  const maximumInput = Math.max(...lines.map(line => line.inputByteUpper));
  const quote = estimatedSemanticProviderUpperUsd({ maximum_attempts: lines.length,
    max_output_tokens: config.max_output_tokens, maximum_input_tokens_per_attempt: maximumInput },
  input.inputUsdPerMillion, input.outputUsdPerMillion);
  if (!Number.isFinite(input.spendCeilingUsd) || quote > input.spendCeilingUsd) {
    throw new AlayaError("CONFLICT", "consumer quote exceeds its finite spend ceiling");
  }
  const executionRoot = canonicalExtractionTargetRoot(join(preparation.output_root, "provider"));
  const binding = initializeExtractionTargetRoot({ cacheRoot: executionRoot, marker: ROOT_MARKER, purpose: "task consumer" });
  const body = {
    contract: "semantic-chain-consumer-authority-v1", kind: TASK_CONSUMER_KIND,
    preparation_identity: preparationIdentity, model: config.model, request_profile: config.request_profile,
    transport_provenance: transport,
    request_timeout: preparation.request_timeout,
    attempt_lineage_digest: consumerAttemptLineage(preparationIdentity, transport),
    execution_scope: { preparation_root: preparation.output_root, execution_root_path: executionRoot,
      execution_root_binding: binding, implementation_revision: readCurrentExtractionAuthorityRevision() },
    limits: { maximum_attempts: lines.length, maximum_attempts_per_key: 1, successful_shard_ceiling: lines.length,
      max_concurrency: 1, max_output_tokens: config.max_output_tokens, output_token_field: "max_tokens" },
    price: { input_usd_per_million: input.inputUsdPerMillion, output_usd_per_million: input.outputUsdPerMillion,
      maximum_input_tokens_per_attempt: maximumInput, estimated_upper_usd: quote,
      spend_ceiling_usd: input.spendCeilingUsd, quote_basis: quoteBasis },
    keys: lines.map(line => line.key)
  };
  const authority = ConsumerAuthoritySchema.parse({ ...body, identity_digest: chainIdentity(body) });
  verifyConsumerAuthority(authority);
  writeChainArtifact(join(preparation.output_root, "authority.json"), authority);
  return authority;
}

/** Authorization is rederived from the admitted replay, never from saved request labels alone. */
export function verifyConsumerAuthority(value: unknown, lease?: ExtractionCacheWriteLease) {
  const authority = parseConsumerAuthority(value);
  assertConsumerExecutionScope(authority, lease);
  return verifyConsumerInputs(authority);
}

/** Re-admit mutable inputs within an already admitted, lease-owned operation. */
export function verifyConsumerOperationInputs(authority: ConsumerAuthority, lease: ExtractionCacheWriteLease) {
  const current = parseConsumerAuthority(authority);
  assertConsumerExecutionRoot(current, lease);
  return verifyConsumerInputs(current);
}

function parseConsumerAuthority(value: unknown): ConsumerAuthority {
  const authority = ConsumerAuthoritySchema.parse(value);
  const { identity_digest, ...body } = authority;
  if (identity_digest !== chainIdentity(body)) throw new AlayaError("CONFLICT", "consumer authority identity changed");
  return authority;
}

function verifyConsumerInputs(authority: ConsumerAuthority) {
  const current = admitConsumerPreparation(authority.execution_scope.preparation_root);
  const { preparation, lines } = current, config = preparation.consumer_config;
  if (authority.preparation_identity !== chainIdentity(preparation) || authority.model !== config.model ||
      canonicalJson(authority.request_timeout) !== canonicalJson(preparation.request_timeout) ||
      authority.request_profile !== config.request_profile || authority.limits.max_output_tokens !== config.max_output_tokens ||
      authority.execution_scope.execution_root_path !== canonicalExtractionTargetRoot(join(preparation.output_root, "provider")) ||
      canonicalJson(authority.keys) !== canonicalJson(lines.map(line => line.key)) ||
      authority.limits.maximum_attempts !== lines.length || authority.limits.successful_shard_ceiling !== lines.length ||
      lines.some(line => canonicalJson(line.transportProvenance) !== canonicalJson(authority.transport_provenance)) ||
      authority.attempt_lineage_digest !== consumerAttemptLineage(authority.preparation_identity, authority.transport_provenance)) {
    throw new AlayaError("CONFLICT", "consumer authority differs from its frozen request scope");
  }
  verifyConsumerQuote(authority, lines.map(line => line.inputByteUpper));
  return { authority, ...current };
}

export function assertConsumerExecutionScope(authority: ConsumerAuthority, lease?: ExtractionCacheWriteLease): void {
  const scope = authority.execution_scope;
  if (scope.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "consumer executable revision changed");
  }
  assertConsumerExecutionRoot(authority, lease);
}

/** An admitted operation rechecks its mutable root without rescanning source history. */
function assertConsumerExecutionRoot(authority: ConsumerAuthority, lease?: ExtractionCacheWriteLease): void {
  const scope = authority.execution_scope;
  assertExtractionTargetRootBinding({ cacheRoot: scope.execution_root_path, marker: ROOT_MARKER,
    binding: scope.execution_root_binding, purpose: "task consumer", ...(lease === undefined ? {} : { writeLease: lease }) });
}

function consumerAttemptLineage(preparationIdentity: string, transport: ConsumerAuthority["transport_provenance"]): string {
  return chainIdentity({ contract: "task-consumer-attempt-lineage-v1", kind: TASK_CONSUMER_KIND,
    preparation_identity: preparationIdentity, transport_provenance: transport });
}

function verifyConsumerQuote(authority: ConsumerAuthority, inputBounds: readonly number[]): void {
  const price = authority.price, transport = authority.transport_provenance;
  const expected = stepQuoteBasisForDigest(transport.model, transport.provider_url_sha256.slice("sha256:".length));
  if (canonicalJson(price.quote_basis) !== canonicalJson(expected) ||
      price.maximum_input_tokens_per_attempt !== Math.max(...inputBounds)) {
    throw new AlayaError("CONFLICT", "consumer quote differs from its transport and input bound");
  }
  assertStepQuoteRates(authority.request_profile, price.input_usd_per_million, price.output_usd_per_million, price.quote_basis);
  for (const bound of inputBounds) assertAttemptInputWithinReceiptLimit(bound, price.maximum_input_tokens_per_attempt);
  const estimated = estimatedSemanticProviderUpperUsd({ maximum_attempts: authority.limits.maximum_attempts,
    max_output_tokens: authority.limits.max_output_tokens, maximum_input_tokens_per_attempt: price.maximum_input_tokens_per_attempt },
  price.input_usd_per_million, price.output_usd_per_million);
  if (price.estimated_upper_usd !== estimated || estimated > price.spend_ceiling_usd) {
    throw new AlayaError("CONFLICT", "consumer price does not bind its finite attempt limits");
  }
}
