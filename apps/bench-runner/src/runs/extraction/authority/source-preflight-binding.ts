import { createHash } from "node:crypto";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { STEP_SEMANTIC_REQUEST_PROFILE } from "../../compile-seed/http/semantic-provider-http.js";
import { isNativeGeminiRequestProfile } from "../request-profile.js";
import { parseSourceSemanticInteractivePreflight } from "../fill/source-semantic-interactive-preflight.js";
import { resolveExtractionTransportRoute } from "../transport-route.js";
import { computeSystemPromptSha256 } from "../cache/extraction-cache-manifest.js";
import { resolveVendorModel } from "../../provider/catalog.js";
import type { ExtractionAuthorityReceipt, ExtractionAuthorityReceiptInput } from "./receipt.js";

/** Verify a retained interactive report against the proof carried by an issued receipt. */
export function assertInteractiveSourcePreflightReceipt(
  value: unknown, receipt: ExtractionAuthorityReceipt
): ReturnType<typeof parseSourceSemanticInteractivePreflight> {
  const report = parseSourceSemanticInteractivePreflight(value);
  if (receipt.source_preflight_digest === undefined ||
      receipt.source_preflight_digest !== sourcePreflightDigest(report)) {
    throw new AlayaError("CONFLICT", "retained interactive source preflight differs from its authority receipt");
  }
  return report;
}

/** An interactive sample can only reserve the exact provider-free preparation it names. */
export function bindInteractiveSourcePreflight(input: ExtractionAuthorityReceiptInput): string | undefined {
  const interactiveSample = input.action === "sample" &&
    (input.observation.extraction.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE ||
      isNativeGeminiRequestProfile(input.observation.extraction.requestProfile) && input.sourcePreflight !== undefined) &&
    input.observation.extraction.sourcePacking === "complete-source";
  if (!interactiveSample) {
    if (input.sourcePreflight !== undefined) {
      throw new AlayaError("VALIDATION", "interactive source preflight proof requires a source sample");
    }
    return undefined;
  }
  if (input.sourcePreflight === undefined || input.sampleScope === undefined ||
      !("missingKeys" in input.inspection)) {
    throw new AlayaError("VALIDATION", "interactive source sample requires retained preflight and native scope");
  }
  const report = parseSourceSemanticInteractivePreflight(input.sourcePreflight);
  const observation = input.observation;
  const route = observation.transport ?? {
    model: observation.extraction.model, providerUrl: observation.extraction.providerUrl
  };
  const preparedRoute = resolveExtractionTransportRoute(report.config);
  if (report.dataset_revision !== observation.dataset.revisionSha256 ||
      report.source_occurrences !== input.inspection.sourceOccurrences ||
      report.unsupported_source_occurrences !== input.inspection.unsupportedSourceOccurrences ||
      report.total_requests !== observation.inventory.expectedTurns ||
      report.config.providerUrl !== observation.extraction.providerUrl ||
      report.config.model !== observation.extraction.model ||
      resolveVendorModel(report.config.modelFamily ?? report.config.model) !==
        resolveVendorModel(observation.extraction.modelFamily) ||
      report.config.requestProfile !== observation.extraction.requestProfile ||
      report.config.sourcePacking !== observation.extraction.sourcePacking ||
      canonicalJson(preparedRoute) !== canonicalJson(route) ||
      canonicalJson(report.selected_keys) !== canonicalJson(input.sampleScope.keys) ||
      report.selected_requests !== input.sampleScope.keys.length ||
      report.planned_requests.some(row =>
        computeSystemPromptSha256(row.systemPrompt) !== observation.extraction.systemPromptSha256) ||
      input.outputTokenCap.field !== report.output_token_field ||
      input.outputTokenCap.value !== report.max_output_tokens ||
      input.priceEstimate.maximumInputTokensPerAttempt !== report.maximum_input_tokens_per_attempt ||
      input.priceEstimate.inputUsdPerMillion !== report.quote_basis.input_usd_equivalent_per_million ||
      input.priceEstimate.outputUsdPerMillion !== report.quote_basis.output_usd_equivalent_per_million) {
    throw new AlayaError("CONFLICT", "interactive source sample authority differs from retained preflight");
  }
  return sourcePreflightDigest(report);
}


function sourcePreflightDigest(report: ReturnType<typeof parseSourceSemanticInteractivePreflight>): string {
  return createHash("sha256").update(canonicalJson(report), "utf8").digest("hex");
}
