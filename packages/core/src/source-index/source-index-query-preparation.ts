import { performance } from "node:perf_hooks";
import {
  sourceIndexConfigurationId, type SourceIndexSelection, type SourceIndexQueryVector, type SourceSemanticQueryPreparation,
  canonicalJson, sourceIndexProfileId, unavailableSourceQueryPreparation, captureSourceSemanticQueryPreparation,
  type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { captureSourceEmbeddingInputs, captureSourceEmbeddingProfile, validateSourceEmbeddingResults,
  sourceEmbeddingInputDigest, sourceEmbeddingSha256, type SourceEmbeddingBindingResult,
  type SourceEmbeddingBindingOptions } from "../embedding-recall/source-embedding-runtime.js";

/** Disabled-channel receipts; not infrastructure unavailability. */
export const ACQUISITION_CHANNEL_NOT_REQUESTED = "acquisition_channel_not_requested";

export type SourceAcquisitionChannelControl = "lexical" | "vector" | "dual";
type SourceQueryPreparationInput = Readonly<{
  navigation: string; supplemental_navigation?: string; evidence_statements?: readonly string[]; selection: SourceIndexSelection | null;
  bind: (options: SourceEmbeddingBindingOptions) => Promise<SourceEmbeddingBindingResult>;
  signal: AbortSignal; remainingMs: () => number;
}>;
type PreparedRoute = Readonly<{ vector: SourceIndexQueryVector; receipt: SourceSemanticQueryPreparation }>;
type PreparedSourceQuery = PreparedRoute & Readonly<{ supplemental?: PreparedRoute; evidence?: readonly PreparedRoute[] }>;

/** Fail closed before bind or SQL. Omitted control is production both-channels. */
export function assertAcquisitionControl(input: Readonly<{
  control?: SourceAcquisitionChannelControl; vector?: SourceIndexQueryVector; receipt?: SourceSemanticQueryPreparation;
  navigation?: string; scoped?: boolean;
  request?: Pick<SourceSemanticWorkerRequest, "kind"> & Readonly<{
    original_query?: string; query_handle?: unknown; continuation?: unknown; continuation_handle?: unknown;
    source_handle?: unknown; access_policy?: string; source_preview_extents?: unknown;
  }>;
}>): void {
  const control = input.control;
  if (control === undefined) return;
  if (control !== "lexical" && control !== "vector" && control !== "dual") {
    throw new CoreError("VALIDATION", "invalid source acquisition channel control");
  }
  if (input.scoped === true) {
    throw new CoreError("VALIDATION", "acquisition channel control cannot use scoped or canonical access");
  }
  const request = input.request;
  if (request !== undefined) {
    if (request.kind !== "recall" || request.query_handle !== undefined || request.continuation !== undefined
      || request.continuation_handle !== undefined || request.source_handle !== undefined
      || request.access_policy === "canonical-v1" || request.source_preview_extents !== undefined) {
      throw new CoreError("VALIDATION", "acquisition channel control requires one initial query-conditioned recall");
    }
    if (input.navigation !== undefined && request.original_query !== undefined
      && request.original_query !== input.navigation) {
      throw new CoreError("VALIDATION", "acquisition channel control navigation does not match the original query");
    }
  }
  if (input.request !== undefined && input.receipt === undefined) {
    throw new CoreError("VALIDATION", "acquisition channel control requires captured query preparation");
  }
  if (control === "lexical") {
    if (input.vector?.status === "available") {
      throw new CoreError("VALIDATION", "lexical acquisition control cannot carry a query embedding");
    }
    if (input.receipt !== undefined && (input.receipt.status !== "not_requested"
      || input.receipt.reason !== ACQUISITION_CHANNEL_NOT_REQUESTED)) {
      throw new CoreError("VALIDATION", "lexical acquisition control requires not_requested preparation");
    }
    return;
  }
  if (input.vector?.status !== "available") {
    throw new CoreError("VALIDATION", "vector acquisition control requires a prepared query vector");
  }
  if (input.navigation !== undefined && input.vector.input_digest !== sourceEmbeddingInputDigest(input.navigation)) {
    throw new CoreError("VALIDATION", "prepared query vector does not match navigation");
  }
  if (input.receipt !== undefined && input.receipt.status !== "ready") {
    throw new CoreError("VALIDATION", "vector acquisition control requires ready query preparation");
  }
}

/** Own prepared domain state before recall callbacks. Receipt/profile capture uses
 * their existing authorities; vector admission (binding, dimensions, norm) remains
 * in snapshot nomination. Typed-array freezing cannot protect elements or backing buffers,
 * so each consumer gets a fresh view of privately retained vector values. */
export function capturePreparedSourceQuery(prepared: PreparedSourceQuery): PreparedSourceQuery {
  const captureRoute = (route: PreparedRoute): PreparedRoute => {
    const vector = route.vector;
    let capturedVector: SourceIndexQueryVector;
    if (vector.status === "unavailable") {
      capturedVector = Object.freeze({ status: vector.status, reason: vector.reason });
    } else {
      const suppliedEmbedding = vector.embedding;
      if (!(suppliedEmbedding instanceof Float32Array)) {
        throw new TypeError("Prepared source query embedding must be a Float32Array");
      }
      const embedding = new Float32Array(suppliedEmbedding);
      capturedVector = Object.freeze({ status: vector.status,
        profile: captureSourceEmbeddingProfile(vector.profile), profile_id: vector.profile_id,
        input_digest: vector.input_digest, get embedding() { return new Float32Array(embedding); } });
    }
    return Object.freeze({ vector: capturedVector, receipt: captureSourceSemanticQueryPreparation(route.receipt) });
  };
  const primary = captureRoute(prepared);
  return Object.freeze({ ...primary, ...(prepared.evidence === undefined ? {} : { evidence: Object.freeze(prepared.evidence.map(captureRoute)) }),
    ...(prepared.supplemental === undefined ? {} : { supplemental: captureRoute(prepared.supplemental) }) });
}

/** Private inference before the native snapshot. Observe the selected configuration; never create one.
 * Capture both texts, the selected configuration and control before the first asynchronous bind.
 * The same binding/profile serves both distinct routes; a failed hint cannot replace original work.
 * Evidence statements reuse the query binding one input at a time, and only through local inference. */
export async function prepareSourceQuery(input: SourceQueryPreparationInput,
  control?: SourceAcquisitionChannelControl): Promise<PreparedSourceQuery> {
  const capturedControl = control;
  if (capturedControl === "lexical") {
    assertAcquisitionControl({ control: capturedControl, navigation: input.navigation });
    return { vector: { status: "unavailable", reason: ACQUISITION_CHANNEL_NOT_REQUESTED },
      receipt: unavailableSourceQueryPreparation(ACQUISITION_CHANNEL_NOT_REQUESTED, "not_requested") };
  }
  if (capturedControl !== undefined && capturedControl !== "vector" && capturedControl !== "dual") {
    throw new CoreError("VALIDATION", "invalid source acquisition channel control");
  }
  const { navigation, supplemental_navigation, signal, remainingMs } = input, statements = input.evidence_statements?.slice();
  const selection = structuredClone(input.selection), bind = input.bind;
  let binding: Promise<SourceEmbeddingBindingResult> | undefined;
  const captured = { navigation, selection, signal, remainingMs,
    bind: (options: SourceEmbeddingBindingOptions) => binding ??= bind(options) };
  const primary = await prepareRoute(captured), evidence: PreparedRoute[] = [];
  for (const statement of statements ?? []) evidence.push(await prepareRoute({ ...captured, navigation: statement }, true));
  const original = statements === undefined ? primary : { ...primary, evidence };
  if (supplemental_navigation === undefined || supplemental_navigation === navigation) return original;
  const supplemental = await prepareRoute({ ...captured, navigation: supplemental_navigation });
  return { ...original, supplemental };
}

async function prepareRoute(input: SourceQueryPreparationInput, localOnly = false): Promise<PreparedRoute> {
  const navigation = input.navigation, selection = input.selection, started = performance.now();
  const bind = input.bind, signal = input.signal, remainingMs = input.remainingMs;
  const digest = sourceEmbeddingInputDigest(navigation);
  let receipt: SourceSemanticQueryPreparation = {
    status: "unavailable", reason: "source_profile_unbound", navigation_digest: digest, selected: null,
    method: "not_run", submitted_inputs: 0, token_count: null, external_api_attempts: 0,
    binding_work: "not_run", execution_work: "not_run", elapsed_ms: 0
  };
  const unavailable = (reason: string, status: "unavailable" | "failed" = "unavailable"): PreparedRoute => ({
    vector: { status: "unavailable", reason: reason.length <= 256 ? reason : "query_preparation_failed" },
    receipt: { ...receipt, status, reason: reason.length <= 256 ? reason : "query_preparation_failed", elapsed_ms: performance.now() - started }
  });
  if (selection === null) return unavailable("source_profile_unbound");
  try {
    const profile = captureSourceEmbeddingProfile(selection.configuration.profile, selection.profile_id);
    if (sourceIndexConfigurationId(selection.configuration, sourceEmbeddingSha256) !== selection.config_id) {
      return unavailable("selected_configuration_mismatch");
    }
    receipt = { ...receipt, selected: { selection_revision: selection.selection_revision,
      config_id: selection.config_id, profile_id: selection.profile_id, profile } };
    signal.throwIfAborted();
    receipt = { ...receipt, binding_work: "unknown", external_api_attempts: null };
    const binding = await bind({ window_bytes: profile.window_bytes, max_input_tokens: profile.max_input_tokens,
      windowing: profile.windowing,
      ...(profile.representation === undefined ? {} : { representation: profile.representation }) });
    // Binding may not support cancellation. Discard anything arriving after the inherited deadline.
    signal.throwIfAborted();
    if (remainingMs() <= 0) return unavailable("preparation_deadline");
    if (binding.status !== "ready") return unavailable(binding.reason);
    const profileId = binding.profile_id;
    const actual = captureSourceEmbeddingProfile(binding.profile, profileId);
    const embed = binding.embedInputs.bind(binding);
    if (profileId !== selection.profile_id || canonicalJson(actual) !== canonicalJson(profile) ||
        sourceIndexProfileId(actual, sourceEmbeddingSha256) !== selection.profile_id) return unavailable("selected_profile_mismatch");
    const method = actual.provider_kind === "local_onnx" ? "local_inference" : "external_api";
    if (localOnly && method !== "local_inference") return unavailable("evidence_statement_requires_local_inference");
    receipt = { ...receipt, method, submitted_inputs: 1, execution_work: "unknown",
      external_api_attempts: method === "local_inference" ? 0 : null };
    const inputs = captureSourceEmbeddingInputs([{ input_id: digest, text: navigation, role: "query" }]);
    const observed = validateSourceEmbeddingResults(inputs, await embed(inputs, {
      profile_id: profileId, signal, timeoutMs: Math.max(1, remainingMs())
    }), actual)[0]!;
    signal.throwIfAborted();
    if (remainingMs() <= 0) return unavailable("preparation_deadline");
    receipt = { ...receipt, token_count: observed.token_count };
    if (observed.status !== "embedded") return unavailable(observed.reason, "failed");
    if (!observed.vector.some(value => value !== 0)) return unavailable("zero_query_vector", "failed");
    return { vector: { status: "available", profile: actual, profile_id: profileId,
      input_digest: observed.input_digest, embedding: observed.vector },
      receipt: { ...receipt, status: "ready", reason: null, elapsed_ms: performance.now() - started } };
  } catch (error) {
    return unavailable(signal.aborted ? "preparation_deadline" :
      error instanceof Error ? "query_preparation_failed" : "query_preparation_unknown", "failed");
  }
}
