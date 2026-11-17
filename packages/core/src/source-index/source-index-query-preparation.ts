import { performance } from "node:perf_hooks";
import {
  sourceIndexConfigurationId, type SourceIndexSelection, type SourceIndexQueryVector, type SourceSemanticQueryPreparation,
  canonicalJson, sourceIndexProfileId, unavailableSourceQueryPreparation, captureSourceSemanticQueryPreparation,
  type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { captureSourceEmbeddingInputs, captureSourceEmbeddingProfile, validateSourceEmbeddingResults,
  SOURCE_EMBEDDING_MAX_BATCH_INPUTS, sourceEmbeddingInputDigest, sourceEmbeddingSha256,
  type SourceEmbeddingBindingResult, type SourceEmbeddingBindingOptions,
  type SourceEmbeddingResult } from "../embedding-recall/source-embedding-runtime.js";

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
 * Local inference batches the query and evidence statements in one embedInputs call; remote inference
 * runs only the primary route and refuses evidence statements without remote submission. */
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
  const original = statements === undefined || statements.length === 0
    ? await prepareRoute(captured).then(primary => statements === undefined ? primary : { ...primary, evidence: [] })
    : await prepareQueryWithStatements(captured, statements);
  if (supplemental_navigation === undefined || supplemental_navigation === navigation) return original;
  const supplemental = await prepareRoute({ ...captured, navigation: supplemental_navigation });
  return { ...original, supplemental };
}

type RouteBase = Readonly<{ text: string; digest: string; receipt: SourceSemanticQueryPreparation }>;
type BoundProfile = Readonly<{
  profileId: string;
  actual: ReturnType<typeof captureSourceEmbeddingProfile>;
  method: "local_inference" | "external_api";
  embed: (inputs: ReturnType<typeof captureSourceEmbeddingInputs>, options: { profile_id: string; signal: AbortSignal; timeoutMs: number }) => Promise<readonly SourceEmbeddingResult[]>;
}>;

function createRouteBase(text: string): RouteBase {
  const digest = sourceEmbeddingInputDigest(text);
  return { text, digest, receipt: {
    status: "unavailable", reason: "source_profile_unbound", navigation_digest: digest, selected: null,
    method: "not_run", submitted_inputs: 0, token_count: null, external_api_attempts: 0,
    binding_work: "not_run", execution_work: "not_run", elapsed_ms: 0
  } };
}

function unavailableFromReceipt(receipt: SourceSemanticQueryPreparation, reason: string, started: number,
  status: "unavailable" | "failed" = "unavailable"): PreparedRoute {
  const bounded = reason.length <= 256 ? reason : "query_preparation_failed";
  return { vector: { status: "unavailable", reason: bounded },
    receipt: { ...receipt, status, reason: bounded, elapsed_ms: performance.now() - started } };
}

async function resolveBoundProfile(input: Pick<SourceQueryPreparationInput, "selection" | "bind" | "signal" | "remainingMs">,
  receiptTemplate: SourceSemanticQueryPreparation): Promise<
    { ok: true; bound: BoundProfile; selected: NonNullable<SourceSemanticQueryPreparation["selected"]> } |
    { ok: false; failure: { reason: string; status: "unavailable" | "failed"; selected: SourceSemanticQueryPreparation["selected"]; bindingWork: "not_run" | "unknown"; externalApiAttempts: number | null } }
  > {
  const { selection, bind, signal, remainingMs } = input;
  if (selection === null) {
    return { ok: false, failure: { reason: "source_profile_unbound", status: "unavailable", selected: null, bindingWork: "not_run", externalApiAttempts: 0 } };
  }
  let selected: NonNullable<SourceSemanticQueryPreparation["selected"]> | null = null;
  let bindingWork: "not_run" | "unknown" = "not_run";
  let externalApiAttempts: number | null = 0;
  try {
    const profile = captureSourceEmbeddingProfile(selection.configuration.profile, selection.profile_id);
    if (sourceIndexConfigurationId(selection.configuration, sourceEmbeddingSha256) !== selection.config_id) {
      return { ok: false, failure: { reason: "selected_configuration_mismatch", status: "unavailable", selected: null, bindingWork, externalApiAttempts } };
    }
    selected = { selection_revision: selection.selection_revision, config_id: selection.config_id, profile_id: selection.profile_id, profile };
    signal.throwIfAborted();
    bindingWork = "unknown"; externalApiAttempts = null;
    const binding = await bind({ window_bytes: profile.window_bytes, max_input_tokens: profile.max_input_tokens,
      windowing: profile.windowing, ...(profile.representation === undefined ? {} : { representation: profile.representation }) });
    // Binding may not support cancellation. Discard anything arriving after the inherited deadline.
    signal.throwIfAborted();
    if (remainingMs() <= 0) return { ok: false, failure: { reason: "preparation_deadline", status: "unavailable", selected, bindingWork, externalApiAttempts } };
    if (binding.status !== "ready") return { ok: false, failure: { reason: binding.reason, status: "unavailable", selected, bindingWork, externalApiAttempts } };
    const profileId = binding.profile_id, actual = captureSourceEmbeddingProfile(binding.profile, profileId);
    if (profileId !== selection.profile_id || canonicalJson(actual) !== canonicalJson(profile) ||
        sourceIndexProfileId(actual, sourceEmbeddingSha256) !== selection.profile_id) {
      return { ok: false, failure: { reason: "selected_profile_mismatch", status: "unavailable", selected, bindingWork, externalApiAttempts } };
    }
    const method = actual.provider_kind === "local_onnx" ? "local_inference" : "external_api";
    return { ok: true, selected, bound: { profileId, actual, method, embed: binding.embedInputs.bind(binding) } };
  } catch (error) {
    return { ok: false, failure: {
      reason: signal.aborted ? "preparation_deadline" : error instanceof Error ? "query_preparation_failed" : "query_preparation_unknown",
      status: "failed", selected: selected ?? receiptTemplate.selected, bindingWork, externalApiAttempts
    } };
  }
}

function routeFromEmbeddingResult(receipt: SourceSemanticQueryPreparation, observed: SourceEmbeddingResult,
  actual: BoundProfile["actual"], profileId: string, started: number): PreparedRoute {
  const withTokens = { ...receipt, token_count: observed.token_count };
  if (observed.status !== "embedded") return unavailableFromReceipt(withTokens, observed.reason, started, "failed");
  if (!observed.vector.some(value => value !== 0)) return unavailableFromReceipt(withTokens, "zero_query_vector", started, "failed");
  return {
    vector: { status: "available", profile: actual, profile_id: profileId, input_digest: observed.input_digest, embedding: new Float32Array(observed.vector) },
    receipt: { ...withTokens, status: "ready", reason: null, elapsed_ms: performance.now() - started }
  };
}

async function embedBatch(bases: readonly RouteBase[], bound: BoundProfile, selected: NonNullable<SourceSemanticQueryPreparation["selected"]>,
  input: Pick<SourceQueryPreparationInput, "signal" | "remainingMs">, started: number): Promise<PreparedRoute[]> {
  const uniqueByText = new Map<string, RouteBase>();
  for (const base of bases) if (!uniqueByText.has(base.text)) uniqueByText.set(base.text, base);
  const uniqueList = [...uniqueByText.values()];
  const routeReceipts = bases.map(base => ({ ...base.receipt, selected, binding_work: "unknown" as const,
    method: bound.method, submitted_inputs: 1, execution_work: "unknown" as const,
    external_api_attempts: bound.method === "local_inference" ? 0 : null }));
  const observedByText = new Map<string, SourceEmbeddingResult>();
  try {
    for (let offset = 0; offset < uniqueList.length; offset += SOURCE_EMBEDDING_MAX_BATCH_INPUTS) {
      input.signal.throwIfAborted();
      if (input.remainingMs() <= 0) return routeReceipts.map(receipt => unavailableFromReceipt(receipt, "preparation_deadline", started));
      const slice = uniqueList.slice(offset, offset + SOURCE_EMBEDDING_MAX_BATCH_INPUTS);
      const inputs = captureSourceEmbeddingInputs(slice.map(item => ({ input_id: item.digest, text: item.text, role: "query" })));
      const validated = validateSourceEmbeddingResults(inputs, await bound.embed(inputs, {
        profile_id: bound.profileId, signal: input.signal, timeoutMs: Math.max(1, input.remainingMs())
      }), bound.actual);
      input.signal.throwIfAborted();
      if (input.remainingMs() <= 0) return routeReceipts.map(receipt => unavailableFromReceipt(receipt, "preparation_deadline", started));
      for (let idx = 0; idx < slice.length; idx += 1) observedByText.set(slice[idx]!.text, validated[idx]!);
    }
    return bases.map((base, idx) => routeFromEmbeddingResult(routeReceipts[idx]!, observedByText.get(base.text)!, bound.actual, bound.profileId, started));
  } catch (error) {
    const reason = input.signal.aborted ? "preparation_deadline" : error instanceof Error ? "query_preparation_failed" : "query_preparation_unknown";
    return routeReceipts.map(receipt => unavailableFromReceipt(receipt, reason, started, "failed"));
  }
}

async function prepareQueryWithStatements(input: SourceQueryPreparationInput, statements: readonly string[]): Promise<PreparedSourceQuery> {
  const started = performance.now();
  const primaryBase = createRouteBase(input.navigation);
  const statementBases = statements.map(createRouteBase);
  const resolved = await resolveBoundProfile(input, primaryBase.receipt);
  if (!resolved.ok) {
    const { reason, status, selected, bindingWork, externalApiAttempts } = resolved.failure;
    const toUnavailable = (base: RouteBase) => unavailableFromReceipt({ ...base.receipt, selected, binding_work: bindingWork,
      external_api_attempts: externalApiAttempts }, reason, started, status);
    return { ...toUnavailable(primaryBase), evidence: statementBases.map(toUnavailable) };
  }
  if (resolved.bound.method !== "local_inference") {
    const [primary] = await embedBatch([primaryBase], resolved.bound, resolved.selected, input, started);
    const evidence = statementBases.map(base => unavailableFromReceipt({ ...base.receipt, selected: resolved.selected,
      binding_work: "unknown", external_api_attempts: null }, "evidence_statement_requires_local_inference", started));
    return { ...primary!, evidence };
  }
  const [primary, ...evidence] = await embedBatch([primaryBase, ...statementBases], resolved.bound, resolved.selected, input, started);
  return { ...primary!, evidence };
}

async function prepareRoute(input: SourceQueryPreparationInput): Promise<PreparedRoute> {
  const started = performance.now(), base = createRouteBase(input.navigation);
  const resolved = await resolveBoundProfile(input, base.receipt);
  if (!resolved.ok) {
    const { reason, status, selected, bindingWork, externalApiAttempts } = resolved.failure;
    return unavailableFromReceipt({ ...base.receipt, selected, binding_work: bindingWork, external_api_attempts: externalApiAttempts }, reason, started, status);
  }
  return (await embedBatch([base], resolved.bound, resolved.selected, input, started))[0]!;
}
