import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readErrorMessage, type GardenProviderKind } from "@do-soul/alaya-protocol";
import {
  extractHeadersFromCauseChain,
  extractRecoveryKindFromInputs,
  extractRetryClassificationFromInputs,
  extractRetryCountFromInputs,
  extractSignalErrorDiagnostic,
  extractStatusFromCauseChain
} from "../compute-provider-diagnostics.js";

const BODY_PREFIX_MAX_CHARS = 4_096;
const PROMPT_PREFIX_MAX_CHARS = 512;

export interface OfficialApiExtractorMeta {
  readonly recoveryKind: string;
  readonly retryCount: number;
  readonly retryClassification?: string;
}

export interface OfficialApiRequestDiagnosticInput {
  readonly diagnosticDir: string | null;
  readonly error: unknown;
  readonly rawJson: string | null;
  readonly userPrompt: string;
  readonly context: {
    readonly workspace_id: string;
    readonly run_id: string;
    readonly surface_id: string | null;
  };
  readonly extractorMeta: OfficialApiExtractorMeta | null;
  readonly providerKind: GardenProviderKind;
  readonly model: string;
  readonly endpoint: string | null;
  readonly now: () => string;
}

export function dumpOfficialApiRequestDiagnostic(input: OfficialApiRequestDiagnosticInput): void {
  if (input.diagnosticDir === null) return;
  try {
    const timestamp = input.now();
    writeDiagnostic(input.diagnosticDir, timestamp, buildDiagnosticEnvelope(input, timestamp));
  } catch (error) {
    console.warn("garden/compute-provider: diagnostic dump failed", {
      error: readErrorMessage(error, "unknown error")
    });
  }
}

function buildDiagnosticEnvelope(input: OfficialApiRequestDiagnosticInput, timestamp: string) {
  return {
    captured_at: timestamp,
    provider_kind: input.providerKind,
    model_id: input.model,
    endpoint: input.endpoint,
    workspace_id: input.context.workspace_id,
    run_id: input.context.run_id,
    surface_id: input.context.surface_id,
    signal_extractor_error: extractSignalErrorDiagnostic(input.error),
    response_status: extractStatusFromCauseChain(input.error),
    response_headers: extractHeadersFromCauseChain(input.error),
    response_body_prefix: input.rawJson?.slice(0, BODY_PREFIX_MAX_CHARS) ?? null,
    response_body_total_chars: input.rawJson?.length ?? null,
    user_prompt_prefix: input.userPrompt.slice(0, PROMPT_PREFIX_MAX_CHARS),
    recovery_kind: extractRecoveryKindFromInputs(input.extractorMeta, input.error),
    extractor_retry_count: extractRetryCountFromInputs(input.extractorMeta, input.error),
    retry_classification: extractRetryClassificationFromInputs(input.extractorMeta, input.error)
  };
}

function writeDiagnostic(directory: string, timestamp: string, envelope: unknown): void {
  const fileName = `${timestamp.replace(/[:.]/gu, "-")}-${randomUUID()}.json`;
  const filePath = join(directory, fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}
