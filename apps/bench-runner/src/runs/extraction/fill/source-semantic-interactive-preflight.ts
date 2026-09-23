import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { SourceSemanticUnsupportedSourceSchema } from "@do-soul/alaya-soul";
import { z } from "zod";
import { parseExtractionSampleKeys } from "../authority/sample-scope.js";
import { attemptInputByteUpperBound } from "../authority/receipt-limits.js";
import { StepQuoteBasisSchema, assertStepQuoteBasis, stepQuoteBasis } from "../authority/step-quote.js";
import { ExtractionTransportProvenanceSchema, buildExtractionTransportProvenance,
  resolveExtractionTransportRoute } from "../transport-route.js";
import { inspectExtractionFillPreparation } from "./fill-preparation.js";
import { prepareSourceRequestWorkset } from "./source-request-workset.js";
import { prepareSourceSemanticRequestWire, sourceSemanticRequestWireDigest } from "./source-semantic-interactive-request.js";
import { STEP_SEMANTIC_REQUEST_PROFILE } from "../../compile-seed/http/semantic-provider-http.js";
import { SourceRequestLineSchema, parseExtractionOpenSemanticsGeneration,
  parseSourceSemanticRequestLine } from "../request-artifact.js";
import type { ExtractionFillOptions } from "../extraction-fill.js";

export const STEP_SOURCE_OUTPUT_TOKEN_DEFAULT = 4096;
const StepSourceOutputTokenCapSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const PlannedRequestSchema = SourceRequestLineSchema.unwrap().extend({
  request_digest: DigestSchema,
  request_url: z.string().url(),
  input_byte_upper: z.number().int().nonnegative()
}).strict().readonly();
const UnsupportedSourceSchema = SourceSemanticUnsupportedSourceSchema.unwrap().extend({
  message_ids: z.array(z.string().min(1)).min(1).readonly(),
  dataset_revision: z.string().min(1),
  provider_attempts: z.literal(0)
}).strict().readonly();
const RetainedPreflightSchema = z.object({
  contract: z.literal("source-semantic-interactive-preflight-v2"),
  execution_authorized: z.literal(false), provider_calls: z.literal(0),
  dataset_revision: z.string().min(1),
  source_occurrences: z.number().int().nonnegative(),
  unsupported_source_occurrences: z.number().int().nonnegative(),
  unsupported_sources: z.array(UnsupportedSourceSchema).readonly(),
  total_requests: z.number().int().nonnegative(),
  selected_requests: z.number().int().nonnegative(),
  selected_keys: z.array(DigestSchema).readonly(),
  cached_requests: z.number().int().nonnegative(),
  config: z.object({
    providerUrl: z.string().min(1), model: z.string().min(1),
    transportProviderUrl: z.string().min(1).optional(),
    transportModel: z.string().min(1).optional(),
    modelFamily: z.string().min(1).optional(),
    requestProfile: z.literal(STEP_SEMANTIC_REQUEST_PROFILE),
    apiKey: z.null(), sourcePacking: z.literal("complete-source"),
    openSemantics: z.unknown()
  }).strict(),
  transport_provenance: ExtractionTransportProvenanceSchema,
  quote_basis: StepQuoteBasisSchema,
  max_output_tokens: StepSourceOutputTokenCapSchema,
  output_token_field: z.literal("max_tokens"),
  maximum_attempts_per_key: z.literal(1),
  maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
  input_token_bound: z.number().int().nonnegative(),
  cost_bound_usd: z.number().nonnegative(),
  planned_requests: z.array(PlannedRequestSchema).readonly()
}).strict().readonly();
export type SourceSemanticInteractivePreflight = z.infer<typeof RetainedPreflightSchema>;

/** Retained reports must still describe this host's exact ready requests and wire. */
export function parseSourceSemanticInteractivePreflight(value: unknown): SourceSemanticInteractivePreflight {
  const report = RetainedPreflightSchema.parse(value);
  const config = { ...report.config,
    openSemantics: parseExtractionOpenSemanticsGeneration(report.config.openSemantics) };
  const route = resolveExtractionTransportRoute(config);
  assertStepQuoteBasis(config.requestProfile, route.model, route.providerUrl, report.quote_basis);
  if (canonicalJson(report.transport_provenance) !== canonicalJson(buildExtractionTransportProvenance(config))) {
    throw new AlayaError("CONFLICT", "retained Step preflight transport provenance differs from its config");
  }
  const sortedKeys = [...report.selected_keys].sort();
  if (new Set(report.selected_keys).size !== report.selected_keys.length ||
      canonicalJson(sortedKeys) !== canonicalJson(report.selected_keys) ||
      report.selected_requests !== report.planned_requests.length ||
      report.cached_requests > report.total_requests ||
      report.selected_keys.length > report.total_requests ||
      report.unsupported_source_occurrences !== report.unsupported_sources.length ||
      report.unsupported_source_occurrences > report.source_occurrences ||
      report.unsupported_sources.some(row => row.dataset_revision !== report.dataset_revision)) {
    throw new AlayaError("CONFLICT", "retained Step preflight population or selected keys are inconsistent");
  }
  const selected = new Set(report.selected_keys);
  const planned = new Set<string>();
  let largestInput = 0, inputBound = 0, costBound = 0;
  for (const row of report.planned_requests) {
    const line = parseSourceSemanticRequestLine({
      key: row.key, unitKeys: row.unitKeys, requestSha256: row.requestSha256,
      systemPrompt: row.systemPrompt, userPrompt: row.userPrompt
    }, config);
    if (!selected.has(line.key) || planned.has(line.key)) {
      throw new AlayaError("CONFLICT", "retained Step preflight repeats or selects a foreign ready key");
    }
    planned.add(line.key);
    const wire = prepareSourceSemanticRequestWire(config, line, report.max_output_tokens);
    const input = attemptInputByteUpperBound(wire.body);
    if (row.request_digest !== sourceSemanticRequestWireDigest(config, line, report.max_output_tokens) ||
        row.request_url !== wire.url.href || row.input_byte_upper !== input) {
      throw new AlayaError("CONFLICT", "retained Step preflight request differs from its encoded wire");
    }
    largestInput = Math.max(largestInput, input);
    inputBound += input;
    costBound += (input * report.quote_basis.input_usd_equivalent_per_million +
      report.max_output_tokens * report.quote_basis.output_usd_equivalent_per_million) / 1_000_000;
  }
  if (report.maximum_input_tokens_per_attempt !== largestInput ||
      report.input_token_bound !== inputBound || report.cost_bound_usd !== costBound) {
    throw new AlayaError("CONFLICT", "retained Step preflight bounds differ from its exact planned requests");
  }
  return report;
}

/** Provider-free interactive preparation; source membership remains catalog-owned. */
export async function preflightSourceSemanticInteractive(options: ExtractionFillOptions & {
  readonly cacheRoot: string;
  readonly preflightKeys?: unknown;
  readonly preflightOutputTokenCap?: number;
}) {
  const maxOutputTokens = StepSourceOutputTokenCapSchema.parse(
    options.preflightOutputTokenCap === undefined
      ? STEP_SOURCE_OUTPUT_TOKEN_DEFAULT : options.preflightOutputTokenCap);
  if (options.batch !== undefined || options.authorityReceiptPath !== undefined ||
      options.ingestionMode === "lazy_field" || options.extractorFactory !== undefined ||
      options.expansionCapability !== undefined || options.openSemantics === undefined ||
      options.sourcePacking !== "complete-source") {
    throw new AlayaError("VALIDATION", "Step source dry preflight requires complete-source open semantics without execution authority");
  }
  const inspected = await inspectExtractionFillPreparation(options, options.cacheRoot, undefined);
  if (inspected.config.requestProfile !== STEP_SEMANTIC_REQUEST_PROFILE) {
    throw new AlayaError("VALIDATION", "interactive source dry preflight requires the Step request profile");
  }
  const selectedKeys = options.preflightKeys === undefined ? undefined :
    new Set(parseExtractionSampleKeys(options.preflightKeys));
  const workset = prepareSourceRequestWorkset({ prepared: inspected, cacheRoot: options.cacheRoot,
    ...(selectedKeys === undefined ? {} : { executionCacheKeys: selectedKeys }) });
  if (workset.unsupportedSources.length !== inspected.unsupportedSourceOccurrences) {
    throw new AlayaError("CONFLICT", "Step host preparation lost unsupported source occurrences");
  }
  const route = resolveExtractionTransportRoute(inspected.config);
  const quote = stepQuoteBasis(route.model, route.providerUrl);
  const requests = workset.lines.map((line) => {
    const wire = prepareSourceSemanticRequestWire(inspected.config, line, maxOutputTokens);
    return { ...line, request_digest: sourceSemanticRequestWireDigest(inspected.config, line, maxOutputTokens),
      request_url: wire.url.href, input_byte_upper: attemptInputByteUpperBound(wire.body) };
  });
  const maximumInputTokensPerAttempt = requests.reduce((max, row) => Math.max(max, row.input_byte_upper), 0);
  const costBoundUsd = requests.reduce((total, row) => total + (
    row.input_byte_upper * quote.input_usd_equivalent_per_million +
    maxOutputTokens * quote.output_usd_equivalent_per_million
  ) / 1_000_000, 0);
  return parseSourceSemanticInteractivePreflight({
    contract: "source-semantic-interactive-preflight-v2" as const,
    execution_authorized: false as const, provider_calls: 0 as const,
    dataset_revision: inspected.datasetRevision,
    source_occurrences: inspected.sourceOccurrences,
    unsupported_source_occurrences: workset.unsupportedSources.length,
    unsupported_sources: workset.unsupportedSources.map(source => ({
      message_ids: source.messageIds, dataset_revision: source.datasetRevision,
      ...source.disposition, provider_attempts: 0 as const
    })),
    total_requests: inspected.completion.expectedTurns,
    selected_requests: requests.length, selected_keys: [...(selectedKeys ?? new Set(requests.map(row => row.key)))],
    cached_requests: workset.cachedRequests.length,
    config: { ...inspected.config, apiKey: null },
    transport_provenance: buildExtractionTransportProvenance(inspected.config),
    quote_basis: quote,
    max_output_tokens: maxOutputTokens, output_token_field: "max_tokens" as const,
    maximum_attempts_per_key: 1 as const,
    maximum_input_tokens_per_attempt: maximumInputTokensPerAttempt,
    input_token_bound: requests.reduce((sum, row) => sum + row.input_byte_upper, 0),
    cost_bound_usd: costBoundUsd,
    planned_requests: requests
  });
}
