import { performance } from "node:perf_hooks";
import {
  sourceIndexConfigurationId, type SourceIndexSelection, type SourceIndexQueryVector, type SourceSemanticQueryPreparation,
  BoundedIdSchema, SourceIndexProfileSchema, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  canonicalJson, hashContentDigest, sourceGoldRootIdentity, sourceIndexProfileId,
  unavailableSourceQueryPreparation,
  type FieldContractSha256, type SourceIndexAcquisitionInput, type SourceIndexAcquisitionResult,
  type SourceIndexLexicalCandidate, type SourceIndexLexicalRank, type SourceIndexNominationAccounting,
  type SourceIndexQueryRepository, type SourceIndexQueryResources, type SourceIndexRootNomination,
  type SourceIndexScopeAdmission, type SourceIndexTarget, type SourceIndexVectorBinding, type SourceIndexVectorCandidate,
  type SourceIndexVectorCursor, type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import { createCosineBatchScorer, isFiniteNonzeroVector } from "../embedding-recall/helpers.js";
import { CoreError } from "../shared/errors.js";
import { captureSourceEmbeddingInputs, captureSourceEmbeddingProfile, validateSourceEmbeddingResults,
  sourceEmbeddingInputDigest, sourceEmbeddingSha256, type SourceEmbeddingBindingResult,
  type SourceEmbeddingBindingOptions } from "../embedding-recall/source-embedding-runtime.js";

type QueryResourceRefusal = SourceIndexAcquisitionResult["resource_refusals"][number];
type ScoredRoot = Readonly<{
  source: SourceIndexTarget; vector: NonNullable<SourceIndexRootNomination["vector"]>;
}>;
type RetainedNomination = {
  source: SourceIndexTarget; lexical: SourceIndexLexicalRank[]; vector: SourceIndexRootNomination["vector"];
};

type SourceQueryPreparationInput = Readonly<{
  navigation: string; supplemental_navigation?: string; selection: SourceIndexSelection | null;
  bind: (options: SourceEmbeddingBindingOptions) => Promise<SourceEmbeddingBindingResult>;
  signal: AbortSignal; remainingMs: () => number;
}>;
type PreparedRoute = Readonly<{ vector: SourceIndexQueryVector; receipt: SourceSemanticQueryPreparation }>;
type PreparedSourceQuery = PreparedRoute & Readonly<{ supplemental?: PreparedRoute }>;
type SourceAcquisitionChannelControl = "lexical" | "vector" | "dual";

/** Production acquisition policy shared by preparation and library access.
 * nominate runs inside the caller-owned read snapshot; prepareQuery runs before it. Neither creates a snapshot lease.
 * Nomination does not run inference, read bodies, select delivery packages or publish public receipts.
 */
export class SourceIndexAcquisition {
  /** Disabled-channel receipts; not infrastructure unavailability. Named consumers: nominate/prepareQuery/assertControl. */
  public static readonly channelNotRequested = "acquisition_channel_not_requested";

  /** Fail closed before bind or SQL. Omitted control is production both-channels. */
  public static assertControl(input: Readonly<{
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
        || input.receipt.reason !== SourceIndexAcquisition.channelNotRequested)) {
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

  /** Private inference before the native snapshot. Observe the selected configuration; never create one. */
  public static async prepareQuery(input: SourceQueryPreparationInput,
    control?: SourceAcquisitionChannelControl): Promise<PreparedSourceQuery> {
    // Capture both texts, the selected configuration and control before the first asynchronous bind.
    // The same binding/profile serves both distinct routes; a failed hint cannot replace original work.
    const capturedControl = control;
    if (capturedControl === "lexical") {
      SourceIndexAcquisition.assertControl({ control: capturedControl, navigation: input.navigation });
      return {
        vector: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested },
        receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested")
      };
    }
    if (capturedControl !== undefined && capturedControl !== "vector" && capturedControl !== "dual") {
      throw new CoreError("VALIDATION", "invalid source acquisition channel control");
    }
    const { navigation, supplemental_navigation, signal, remainingMs } = input;
    const selection = structuredClone(input.selection), bind = input.bind;
    let binding: Promise<SourceEmbeddingBindingResult> | undefined;
    const captured = { navigation, selection, signal, remainingMs,
      bind: (options: SourceEmbeddingBindingOptions) => binding ??= bind(options) };
    const original = await SourceIndexAcquisition.prepareRoute(captured);
    if (supplemental_navigation === undefined || supplemental_navigation === navigation) return original;
    const supplemental = await SourceIndexAcquisition.prepareRoute({ ...captured, navigation: supplemental_navigation });
    return { ...original, supplemental };
  }

  private static async prepareRoute(input: SourceQueryPreparationInput): Promise<PreparedRoute> {
    const navigation = input.navigation, selection = input.selection, started = performance.now();
    const bind = input.bind, signal = input.signal, remainingMs = input.remainingMs;
    const digest = sourceEmbeddingInputDigest(navigation);
    let receipt: SourceSemanticQueryPreparation = {
      status: "unavailable", reason: "source_profile_unbound", navigation_digest: digest, selected: null,
      method: "not_run", submitted_inputs: 0, token_count: null, external_api_attempts: 0,
      binding_work: "not_run", execution_work: "not_run", elapsed_ms: 0
    };
    const unavailable = (reason: string, status: "unavailable" | "failed" = "unavailable"): PreparedSourceQuery => ({
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
      const binding = await bind({ window_bytes: profile.window_bytes, max_input_tokens: profile.max_input_tokens });
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
      receipt = { ...receipt, method, submitted_inputs: 1, execution_work: "unknown",
        external_api_attempts: method === "local_inference" ? 0 : null };
      const inputs = captureSourceEmbeddingInputs([{ input_id: digest, text: navigation }]);
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

  public constructor(private readonly repository: SourceIndexQueryRepository, private readonly sha256: FieldContractSha256) {}

  public nominate(input: SourceIndexAcquisitionInput, admitScope: SourceIndexScopeAdmission,
    control?: SourceAcquisitionChannelControl): SourceIndexAcquisitionResult {
    validateInput(input, admitScope);
    const capturedControl = control;
    SourceIndexAcquisition.assertControl({ control: capturedControl, vector: input.vector, navigation: input.navigation_text });
    const captured = { ...input, allowance: { ...input.allowance }, budget: { ...input.budget } };
    return new AcquisitionQuery(this.repository, this.sha256, captured, admitScope, capturedControl).run();
  }
}

/** Fixed-prefix policy: collect at most max_attempts lexical rows and max_vector_windows vectors;
 * rank best observed window/root, then alternate lexical/vector root slots, lexical first.
 * Each slot (including denied, unknown, stale, duplicate and union-full) consumes one attempt.
 * Exhausted channels are skipped; there is no discovery refill. Lane ranks are not fused scores.
 */
class AcquisitionQuery {
  private readonly meter: SourceSemanticResourceLedger;
  private nativeBytes = 0;
  private navigationDigest: string | null = null;
  private queryVector: Float32Array | null = null;
  private scoreVector: ((right: Float32Array) => number) | null = null;
  private vectorBinding: SourceIndexVectorBinding | null = null;
  private lexicalCandidates: readonly SourceIndexLexicalCandidate[] = [];
  private vectorCandidates: readonly ScoredRoot[] = [];
  private readonly nominations = new Map<string, RetainedNomination>();
  private readonly counts = { attempted: 0, admitted: 0, duplicate: 0, rejected: 0,
    scope_denied: 0, native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 } satisfies SourceIndexNominationAccounting;
  private readonly resourceRefusals: QueryResourceRefusal[] = [];
  private stage: QueryResourceRefusal["stage"] = "input";
  private lexical: SourceIndexAcquisitionResult["lexical"] = {
    completion: "not_run", index_coverage: "partial", reason: "read_budget", limitations: [], tokenization: null
  };
  private vector: SourceIndexAcquisitionResult["vector"];
  private limited = false;

  constructor(private readonly repository: SourceIndexQueryRepository, private readonly sha256: FieldContractSha256,
    private readonly input: SourceIndexAcquisitionInput, private readonly admitScope: SourceIndexScopeAdmission,
    private readonly control?: SourceAcquisitionChannelControl) {
    this.meter = new SourceSemanticResourceLedger(input.budget);
    const vector = input.vector;
    // Capture supplied preparation metadata even if the result envelope or validation cannot be funded.
    this.vector = { completion: "not_run", state: null, reason: "validation_not_run", inspected_windows: 0,
      invalid_windows: 0, ranking: "exact_over_inspected_subset",
      validation: vector.status === "available" ? "not_run" : "not_applicable",
      input: vector.status === "available" ? { status: "available", profile_id: vector.profile_id,
        input_digest: vector.input_digest } : { status: "unavailable", reason: vector.reason } };
  }

  run(): SourceIndexAcquisitionResult {
    try {
      // Result envelope and per-nomination output references are admitted before discovery can exhaust the ledger.
      this.meter.charge(1, 2048 + 8 * this.input.allowance.max_roots, "source acquisition result envelope");
      this.prepareInput();
      this.stage = "lexical";
      if (this.control === "vector") {
        this.lexical = { completion: "not_run", index_coverage: "partial",
          reason: SourceIndexAcquisition.channelNotRequested, limitations: [], tokenization: null };
      } else {
        const lexical = this.repository.readLexicalCandidates(this.input.workspace_id, this.input.navigation_text,
          this.input.allowance.max_attempts, this.meter.remaining());
        this.lexicalCandidates = lexical.candidates;
        this.lexical = { completion: lexical.completion, reason: lexical.reason,
          index_coverage: lexical.index_coverage, limitations: lexical.limitations, tokenization: lexical.tokenization };
        if (lexical.resource_refusal) this.resourceRefusals.push(lexical.resource_refusal);
        this.absorb(lexical.resources);
      }
      this.stage = "vector";
      if (this.control !== "lexical") this.scanVectors();
      this.stage = "nomination"; this.nominatePrefix();
    } catch (error) {
      // Keep all completed debits even when a repository or admission callback fails.
      // Work inside the failed operation remains unknown; it is not successful absence.
      this.resourceRefusals.push({ stage: this.stage, phase: error instanceof SourceSemanticResourceExhausted
        ? error.phase : "acquisition_failed_unknown_additional_cost" });
      if (this.stage === "input" && this.vector.completion === "not_run") {
        this.vector = { ...this.vector, reason: error instanceof SourceSemanticResourceExhausted ? "read_budget" : "acquisition_failed" };
      }
      this.limited = true;
    }
    const lexicalDone = this.lexical.completion === "complete" || this.control === "vector" && this.lexical.completion === "not_run";
    const complete = !this.limited && this.counts.native_unknown === 0 && lexicalDone &&
      (this.vector.completion === "complete" || this.vector.completion === "not_run");
    return {
      policy: "source-index-interleaved-prefix.v1", navigation_digest: this.navigationDigest,
      completion: complete ? "complete" : this.nominations.size === 0 && this.lexical.completion === "unavailable" &&
        this.vector.completion === "unavailable" ? "unavailable" : "partial",
      nominations: [...this.nominations.values()], accounting: this.counts,
      resources: { work: this.meter.spentWork, memory_bytes: this.meter.spentBytes,
        native_bytes: this.nativeBytes, sql_internal_work: "unknown" },
      lexical: this.lexical, vector: this.vector, resource_refusals: this.resourceRefusals,
      limitations: ["nominations_are_not_source_absence", "sqlite_internal_work_unknown",
        "native_deadline_and_interruption_require_daemon_integration", "caller_owned_read_snapshot_required",
        "lexical_corpus_coverage_untracked"]
    };
  }

  private prepareInput(): void {
    this.meter.retain(this.input.navigation_text, "source navigation capture");
    this.meter.charge(this.input.navigation_text.length, 0, "source navigation digest");
    this.navigationDigest = hashContentDigest(this.input.navigation_text, this.sha256);
    const vector = this.input.vector;
    if (this.control === "lexical") {
      this.vector = { completion: "not_run", state: null, reason: SourceIndexAcquisition.channelNotRequested,
        inspected_windows: 0, invalid_windows: 0, ranking: "exact_over_inspected_subset", validation: "not_applicable",
        input: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested } };
      return;
    }
    if (vector.status === "unavailable") {
      this.meter.retain(vector.reason);
      this.vector = { ...this.vector, completion: "unavailable", reason: vector.reason };
      return;
    }
    this.meter.retain(vector.profile, "source query profile");
    const parsed = SourceIndexProfileSchema.safeParse(vector.profile);
    if (!parsed.success) { this.unavailableVector("invalid_profile"); return; }
    this.meter.charge(1, 256, "source query binding");
    if (sourceIndexProfileId(parsed.data, this.sha256) !== vector.profile_id) {
      this.unavailableVector("profile_binding_mismatch"); return;
    }
    if (vector.input_digest !== this.navigationDigest) { this.unavailableVector("input_binding_mismatch"); return; }
    const dimensions = parsed.data.dimensions;
    this.meter.charge(3 * dimensions, 4 * dimensions, "source query vector capture, validation and norm");
    if (!(vector.embedding instanceof Float32Array) || vector.embedding.length !== dimensions || !isFiniteNonzeroVector(vector.embedding)) {
      this.unavailableVector("invalid_query_vector"); return;
    }
    this.queryVector = new Float32Array(vector.embedding);
    this.scoreVector = createCosineBatchScorer(this.queryVector);
    this.vector = { ...this.vector, reason: null, validation: "validated" };
  }

  private unavailableVector(reason: string): void {
    this.vector = { ...this.vector, completion: "unavailable", reason, validation: "invalid" };
  }

  private scanVectors(): void {
    if (this.queryVector === null) return;
    const best = new Map<string, ScoredRoot>();
    let cursor: SourceIndexVectorCursor | null = null, remaining = this.input.allowance.max_vector_windows;
    if (remaining === 0) { this.vector = { ...this.vector, completion: "partial", reason: "window_limit" }; return; }
    try {
      while (remaining > 0) {
        const page = this.repository.readVectorCandidates(this.input.workspace_id, cursor,
          Math.min(128, remaining), this.meter.remaining());
        const previousState = this.vector.state;
        this.vector = { ...this.vector, state: page.state, completion: page.completion, reason: page.reason,
          inspected_windows: this.vector.inspected_windows + page.inspected,
          invalid_windows: this.vector.invalid_windows + page.invalid };
        if (page.resource_refusal) this.resourceRefusals.push(page.resource_refusal);
        this.absorb(page.resources);
        if (!("binding" in page.state)) {
          if (page.reason === "read_budget") {
            this.vector = { ...this.vector, state: previousState ?? page.state, completion: "partial" }; break;
          }
          best.clear(); return;
        }
        const binding = page.state.binding;
        this.meter.charge(1, 0, "source vector page binding");
        if (page.reason === "active_generation_changed" || this.vectorBinding !== null &&
            canonicalJson(this.vectorBinding) !== canonicalJson(binding)) {
          this.vector = { ...this.vector, completion: "unavailable", reason: "active_generation_changed" };
          this.vectorBinding = null; best.clear(); return;
        }
        if (this.vector.input.status !== "available" || this.vector.input.profile_id !== binding.profile_id ||
            this.queryVector.length !== binding.dimensions) {
          this.vector = { ...this.vector, completion: "unavailable", reason: "selected_profile_mismatch" }; best.clear(); return;
        }
        this.vectorBinding = binding;
        for (const candidate of page.candidates) this.considerVector(best, candidate);
        remaining -= page.inspected;
        if (page.completion === "complete" || page.completion === "unavailable" || page.reason === "read_budget") break;
        if (page.inspected === 0 || page.cursor === null || page.cursor.after_window_id === cursor?.after_window_id) {
          this.vector = { ...this.vector, completion: "partial", reason: "scan_did_not_advance" }; break;
        }
        cursor = page.cursor;
      }
      if (remaining === 0 && this.vector.completion === "partial" && this.vector.reason === "window_page_limit") {
        this.vector = { ...this.vector, completion: "partial", reason: "window_limit" };
      }
      if (this.vector.invalid_windows > 0 && this.vector.completion === "complete") {
        this.vector = { ...this.vector, completion: "partial", reason: "invalid_vectors" };
      }
      this.meter.charge(1, 64 + best.size * 8, "source vector root ordering");
      const ranked = [...best.values()];
      ranked.sort((left, right) => {
        this.meter.charge(1, 0, "source vector root comparison");
        return right.vector.cosine - left.vector.cosine || compareKey(left.source.root_key, right.source.root_key) ||
          compareKey(left.vector.window.window_id, right.vector.window.window_id);
      });
      this.vectorCandidates = ranked.map((candidate, index) => {
        this.meter.charge(1, 128, "source vector rank retention");
        return { ...candidate, vector: { ...candidate.vector, rank: index + 1 } };
      });
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      this.resourceRefusals.push({ stage: "vector", phase: error.phase });
      if (this.vector.completion !== "unavailable") {
        this.vector = { ...this.vector, completion: "partial",
          reason: this.vector.reason === "read_budget" ? "read_budget" : "scoring_budget" };
      }
      this.limited = true;
      // An unfinished sort is not an exact ranked subset. Lexical candidates remain independently usable.
      this.vectorCandidates = [];
    }
  }

  private considerVector(best: Map<string, ScoredRoot>, candidate: SourceIndexVectorCandidate): void {
    const dimensions = this.queryVector!.length;
    this.meter.charge(2 * dimensions, 0, "source vector validation and cosine");
    if (candidate.embedding.length !== dimensions || !isFiniteNonzeroVector(candidate.embedding)) {
      this.vector = { ...this.vector, completion: "partial", reason: "invalid_vectors",
        invalid_windows: this.vector.invalid_windows + 1 }; return;
    }
    const cosine = this.scoreVector!(candidate.embedding);
    if (!Number.isFinite(cosine)) return;
    const key = sourceGoldRootIdentity(candidate.source.target);
    this.meter.charge(1 + key.length, 0, "source vector root lookup");
    const previous = best.get(key);
    if (previous !== undefined && (previous.vector.cosine > cosine || previous.vector.cosine === cosine &&
        compareKey(previous.vector.window.window_id, candidate.window.window_id) <= 0)) return;
    this.meter.charge(1, 128 + 4 * key.length, "source vector best-window retention");
    best.set(key, { source: candidate.source, vector: { rank: 0, cosine, window: candidate.window } });
  }

  private nominatePrefix(): void {
    let lexicalIndex = 0, vectorIndex = 0, takeLexical = true;
    while (this.counts.attempted < this.input.allowance.max_attempts &&
        (lexicalIndex < this.lexicalCandidates.length || vectorIndex < this.vectorCandidates.length)) {
      const lexicalTurn: boolean = lexicalIndex < this.lexicalCandidates.length &&
        (takeLexical || vectorIndex >= this.vectorCandidates.length);
      takeLexical = !lexicalTurn;
      const lexical = lexicalTurn ? this.lexicalCandidates[lexicalIndex++]! : null;
      const vector = lexicalTurn ? null : this.vectorCandidates[vectorIndex++]!;
      const source = lexical?.source ?? vector!.source;
      this.stage = "nomination";
      this.meter.charge(1 + source.root_key.length, 0, "source nomination attempt");
      this.counts.attempted++;
      this.stage = "admission";
      try {
        const admission = this.repository.admitQueryCandidate(source, vector === null ? null : this.vectorBinding, this.meter.remaining());
        this.absorb(admission.resources);
        if (admission.status !== "ready") {
          this.counts.rejected++;
          if (admission.status === "resource_limited") {
            this.counts.resource_refused++;
            this.resourceRefusals.push({ stage: "admission", phase: admission.phase });
            this.limited = true; break;
          }
          if (admission.status === "stale") this.counts.stale++; else this.counts.native_unknown++;
          continue;
        }
        this.meter.charge(1 + (admission.scope_class?.length ?? 0), 0, "source scope admission");
        const scope = this.admitScope(admission.scope_class, source);
        if (scope === "denied") { this.counts.rejected++; this.counts.scope_denied++; continue; }
        if (scope !== "admitted") throw new CoreError("VALIDATION", "invalid source scope admission result");
        this.stage = "nomination";
        this.retainNomination(source, lexical?.lexical ?? null, vector?.vector ?? null);
      } catch (error) {
        // A thrown admission leaves this attempt unsettled, not a native-unknown result.
        if (this.counts.attempted > this.counts.admitted + this.counts.duplicate + this.counts.rejected) {
          this.counts.rejected++;
        }
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        this.counts.resource_refused++;
        this.resourceRefusals.push({ stage: this.stage, phase: error.phase });
        this.limited = true; break;
      }
    }
    if (lexicalIndex < this.lexicalCandidates.length || vectorIndex < this.vectorCandidates.length) this.limited = true;
  }

  private retainNomination(source: SourceIndexTarget, lexical: SourceIndexLexicalRank | null,
    vector: SourceIndexRootNomination["vector"]): void {
    const key = sourceGoldRootIdentity(source.target), previous = this.nominations.get(key);
    if (previous !== undefined) {
      this.meter.charge(1, lexical === null ? 0 : 8, "source nomination overlap");
      if (lexical !== null) previous.lexical.push(lexical);
      if (vector !== null) previous.vector = vector;
      this.counts.duplicate++; return;
    }
    if (this.nominations.size >= this.input.allowance.max_roots) {
      this.counts.rejected++; this.counts.nomination_limit++; this.limited = true; return;
    }
    this.meter.charge(1 + key.length, 192 + 4 * key.length, "source nomination retention");
    this.nominations.set(key, { source, lexical: lexical === null ? [] : [lexical], vector });
    this.counts.admitted++;
  }

  private absorb(resources: SourceIndexQueryResources): void {
    this.meter.charge(resources.work, resources.memory_bytes, "source index bounded native phase");
    this.nativeBytes += resources.native_bytes;
  }
}

function validateInput(input: SourceIndexAcquisitionInput, admitScope: SourceIndexScopeAdmission): void {
  BoundedIdSchema.parse(input.workspace_id);
  if (typeof admitScope !== "function" || typeof input.navigation_text !== "string") {
    throw new CoreError("VALIDATION", "source index query requires captured text and scope admission");
  }
  const { max_attempts: attempts, max_roots: roots, max_vector_windows: windows } = input.allowance;
  // These are safety ceilings, not adopted product defaults or independent channel resource envelopes.
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 128 ||
      !Number.isSafeInteger(roots) || roots < 1 || roots > 16 || roots > attempts ||
      !Number.isSafeInteger(windows) || windows < 0 || windows > 4096 ||
      !Number.isSafeInteger(input.budget.work_units) || input.budget.work_units < 0 ||
      !Number.isSafeInteger(input.budget.memory_bytes) || input.budget.memory_bytes < 0 ||
      input.vector.status !== "available" && input.vector.status !== "unavailable" ||
      input.vector.status === "unavailable" && (typeof input.vector.reason !== "string" ||
        input.vector.reason.length < 1 || input.vector.reason.length > 256)) {
    throw new CoreError("VALIDATION", "invalid bounded source index query allowance");
  }
}
function compareKey(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
