import {
  QuestionTimePreferenceSchema, SourceIndexProfileSchema, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  canonicalJson, hashContentDigest, sourceIndexProfileId, sourceIndexNativeRootKey,
  type FieldContractSha256, type SourceIndexAcquisitionInput, type SourceIndexAcquisitionResult,
  type SourceSemanticResourceBudget, type SourceIndexQueryCapacity,
  type SourceIndexLexicalCandidate, type SourceIndexLexicalRank, type SourceIndexNominationAccounting,
  type SourceIndexQueryAdmission, type SourceIndexQueryRepository, type SourceIndexQueryResources,
  type SourceIndexRootNomination, type SourceIndexScopeAdmission, type SourceIndexTarget, type SourceIndexVectorBinding,
  type SourceIndexVectorCandidate, type SourceIndexVectorCursor,
  type SourceSemanticNominationOccurrence, type QuestionTimePreference
} from "@do-soul/alaya-protocol";
import { createValidatedCosineBatchScorer, isFiniteNonzeroVector } from "../embedding-recall/helpers.js";
import { CoreError } from "../shared/errors.js";
import { preferQuestionTime, recordedQuestionTime, type SourcePreferenceRetention } from "./question-time-preference.js";
import { validateInput } from "./source-index-acquisition-input.js";
import { collapseStatementCandidates, evidenceWindow, StatementKeyRetention, quoteStatementAssociation, type EvidenceDemands,
  type StatementAssociation } from "./statement-association.js";
import { restoreSourceTemplate } from "./source-template-restoration.js";
import { preferTaskObservations } from "./task-observation-preference.js";
import { VECTOR_COST, acquisitionResultEnvelopeCost, acquisitionNavigationDigestCost,
  acquisitionQueryBindingCost, acquisitionQueryVectorNormCost, acquisitionEnvelopeAndInputCaptureCost } from "./acquisition-prices.js";
import { observeLexicalCandidates, sourceTaskInventory, type NativeAdmissionFact,
  type SourceIndexAcquisitionFact, type SourceIndexAcquisitionObserver } from "./acquisition-observation.js";
import {
  ACQUISITION_CHANNEL_NOT_REQUESTED, assertAcquisitionControl, capturePreparedSourceQuery, prepareSourceQuery,
  type SourceAcquisitionChannelControl
} from "./source-index-query-preparation.js";

type QueryResourceRefusal = SourceIndexAcquisitionResult["resource_refusals"][number];
type ScoredRoot = Readonly<{
  source: SourceIndexTarget; vector: NonNullable<SourceIndexRootNomination["vector"]>;
}>;
type RetainedNomination = {
  source: SourceIndexTarget; lexical: SourceIndexLexicalRank[]; vector: SourceIndexRootNomination["vector"];
};
type AcquisitionCapture = Readonly<{
  view: "original" | "hint"; grouped: boolean; retained: SourceSemanticNominationOccurrence[];
  progress: { lexical: number; vector: number }; associate?: EvidenceDemands;
  preferenceRetention?: SourcePreferenceRetention; observationSourceId?: string; indexMembers?: number;
}>;

/** Snapshot nomination coordinator. prepareQuery runs before the caller-owned read snapshot;
 * nominate runs inside it. Neither creates a snapshot lease.
 * Nomination does not run inference, read bodies, select delivery packages or publish public receipts.
 * Observation facts stay in this producer so they can be captured before candidate loss; they are not a second policy.
 */
export class SourceIndexAcquisition {
  /** Disabled-channel receipts; not infrastructure unavailability. Named consumers: nominate/prepareQuery/assertControl. */
  public static readonly channelNotRequested = ACQUISITION_CHANNEL_NOT_REQUESTED;

  /** Planning quotation of envelope and input capture. Not a debit. Named consumer: acquireRoute. */
  public static quoteEnvelopeAndInputCapture = acquisitionEnvelopeAndInputCaptureCost;

  public static assertControl = assertAcquisitionControl;
  public static capturePreparedQuery = capturePreparedSourceQuery;
  public static prepareQuery = prepareSourceQuery;

  public constructor(private readonly repository: SourceIndexQueryRepository, private readonly sha256: FieldContractSha256) {}

  /** Ordinary acquisition is funded by its bounded native reads, not a delivery page's remainder.
   * The conservative ordering bound permits every comparison of the inspected roots;
   * receipts still report only executed debits. Native guards can refuse on their own bounds.
   */
  public static quoteAllowanceBudget(input: Omit<SourceIndexAcquisitionInput, "budget">,
    native: SourceIndexQueryCapacity): SourceSemanticResourceBudget {
    const captured = SourceIndexAcquisition.quoteEnvelopeAndInputCapture({ navigation: input.navigation_text,
      vector: input.vector, max_roots: input.allowance.max_roots }, native.budget);
    const windows = native.vector_windows;
    const association = quoteStatementAssociation(input.allowance.max_roots, windows, native.dimensions);
    return {
      work_units: native.budget.work_units + captured.work_units + native.resources.work
        + VECTOR_COST.ordering_work + windows * (VECTOR_COST.validation_per_dimension * native.dimensions
          + VECTOR_COST.lookup_work + VECTOR_COST.replacement_work + VECTOR_COST.rank_work)
        + windows * windows * VECTOR_COST.comparison_work + association.work_units,
      memory_bytes: native.budget.memory_bytes + captured.memory_bytes + native.resources.memory_bytes
        + VECTOR_COST.ordering_bytes + windows * (VECTOR_COST.replacement_bytes
          + VECTOR_COST.key_bytes_per_character * native.root_key_bytes + VECTOR_COST.rank_bytes + VECTOR_COST.ordering_reference_bytes)
        + association.memory_bytes
    };
  }

  /** Private comparison producer: real captured pages, not observer diagnostics. */
  public captureNative(input: SourceIndexAcquisitionInput, admitScope: SourceIndexScopeAdmission,
    view: "original" | "hint", grouped: boolean, control: SourceAcquisitionChannelControl, observer?: SourceIndexAcquisitionObserver) {
    validateInput(input, admitScope, grouped ? 128 : 16);
    const retained: SourceSemanticNominationOccurrence[] = [];
    const progress = { lexical: 0, vector: 0 };
    const query = new AcquisitionQuery(this.repository, this.sha256, input, admitScope, control,
      observer, { view, grouped, retained, progress });
    const result = query.run(grouped);
    return { result, retained, progress, ...query.capturedNative() };
  }

  /** Runtime capture retains every admitted occurrence before root occupancy is projected.
   * The caller owns the snapshot and the returned inventory's lifetime. Statement-key association runs
   * only on request for the original view, whose budget must include `quoteStatementAssociation`;
   * its keys yield coverage only for supplied evidence statements.
   */
  public nominateWithWitness(input: SourceIndexAcquisitionInput, admitScope: SourceIndexScopeAdmission,
    view: "original" | "hint" = "original", observer?: SourceIndexAcquisitionObserver, associate?: EvidenceDemands,
    preferenceRetention?: SourcePreferenceRetention, observationSourceId?: string, indexMembers = 0) {
    validateInput(input, admitScope);
    const retained: SourceSemanticNominationOccurrence[] = [];
    const query = new AcquisitionQuery(this.repository, this.sha256, input, admitScope, undefined,
      observer, { view, grouped: false, retained, progress: { lexical: 0, vector: 0 }, associate: view === "original" ? associate : undefined,
        ...(view === "original" && preferenceRetention !== undefined ? { preferenceRetention } : {}), observationSourceId,
        indexMembers: view === "original" ? indexMembers : 0 });
    const result = query.run();
    return { result, witness: retained, ...(indexMembers > 0 && view === "original" ? { index_members: query.indexMembers } : {}),
      ...(query.questionTimeOrder === undefined ? {}
      : { question_time_order: query.questionTimeOrder }), ...(query.association === undefined ? {} : { association: query.association }),
      ...(query.prepaidBaseBytes === undefined ? {} : { prepaid_base_bytes: query.prepaidBaseBytes }) };
  }

  public nominate(input: SourceIndexAcquisitionInput, admitScope: SourceIndexScopeAdmission,
    control?: SourceAcquisitionChannelControl, observer?: SourceIndexAcquisitionObserver): SourceIndexAcquisitionResult {
    validateInput(input, admitScope);
    const capturedControl = control;
    SourceIndexAcquisition.assertControl({ control: capturedControl, vector: input.vector, navigation: input.navigation_text });
    const captured = { ...input, allowance: { ...input.allowance }, budget: { ...input.budget } };
    return new AcquisitionQuery(this.repository, this.sha256, captured, admitScope, capturedControl, observer).run();
  }
}

/** Fixed-prefix policy: collect at most max_attempts lexical rows and max_vector_windows vectors;
 * rank best observed window/root, then alternate lexical/vector root slots, lexical first.
 * Each slot (including denied, unknown, stale, duplicate and union-full) consumes one attempt.
 * Exhausted channels are skipped; there is no discovery refill. Lane ranks are not fused scores.
 */
class AcquisitionQuery {
  private readonly meter: SourceSemanticResourceLedger;
  private readonly originalQuestionTime: QuestionTimePreference | undefined;
  private readonly input: SourceIndexAcquisitionInput;
  private nativeBytes = 0;
  private navigationDigest: string | null = null;
  private queryVector: Float32Array | null = null;
  private scoreVector: ((right: Float32Array) => number | null) | null = null;
  private vectorBinding: SourceIndexVectorBinding | null = null;
  private lexicalCandidates: readonly SourceIndexLexicalCandidate[] = [];
  private vectorCandidates: readonly ScoredRoot[] = [];
  private readonly nominations = new Map<string, RetainedNomination>();
  private readonly unboundAdmissions = new Map<string, SourceIndexQueryAdmission>();
  private readonly boundAdmissions = new Map<string, SourceIndexQueryAdmission>();
  private readonly counts = { attempted: 0, admitted: 0, duplicate: 0, rejected: 0,
    scope_denied: 0, native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 } satisfies SourceIndexNominationAccounting;
  private readonly resourceRefusals: QueryResourceRefusal[] = [];
  private stage: QueryResourceRefusal["stage"] = "input";
  private lexical: SourceIndexAcquisitionResult["lexical"] = {
    completion: "not_run", index_coverage: "partial", reason: "read_budget", limitations: [], tokenization: null
  };
  private vector: SourceIndexAcquisitionResult["vector"];
  private limited = false;
  private timeRoute = false;
  public questionTimeOrder?: readonly string[];
  public association?: StatementAssociation;
  public prepaidBaseBytes?: number;
  /** Admitted roots refused only by the root limit, in attempt order; listed, never nominated. */
  public readonly indexMembers: SourceIndexTarget[] = [];
  private readonly indexMemberKeys = new Set<string>();
  private readonly statements?: StatementKeyRetention;

  constructor(private readonly repository: SourceIndexQueryRepository, private readonly sha256: FieldContractSha256,
    input: SourceIndexAcquisitionInput, private readonly admitScope: SourceIndexScopeAdmission,
    private readonly control: SourceAcquisitionChannelControl | undefined,
    private readonly observer: SourceIndexAcquisitionObserver | undefined,
    private readonly capture?: AcquisitionCapture) {
    const { question_time: proposed, ...rest } = input;
    const recorded = proposed && recordedQuestionTime(QuestionTimePreferenceSchema.parse(proposed));
    this.originalQuestionTime = proposed;
    this.input = { ...rest, ...(recorded === undefined ? {} : { question_time: recorded }) };
    this.meter = new SourceSemanticResourceLedger(input.budget);
    if (capture?.associate !== undefined) this.statements = new StatementKeyRetention(this.meter,
      phase => this.resourceRefusals.push({ stage: this.stage, phase }), capture.associate);
    const vector = input.vector;
    // Capture supplied preparation metadata even if the result envelope or validation cannot be funded.
    this.vector = { completion: "not_run", state: null, reason: "validation_not_run", inspected_windows: 0,
      invalid_windows: 0, ranking: "exact_over_inspected_subset",
      validation: vector.status === "available" ? "not_run" : "not_applicable",
      input: vector.status === "available" ? { status: "available", profile_id: vector.profile_id,
        input_digest: vector.input_digest } : { status: "unavailable", reason: vector.reason } };
  }

  capturedNative() { return { lexical: this.lexicalCandidates, vector: this.vectorCandidates, binding: this.vectorBinding }; }

  run(captureOnly = false): SourceIndexAcquisitionResult {
    try {
      // Result envelope and per-nomination output references are admitted before discovery can exhaust the ledger.
      const envelope = acquisitionResultEnvelopeCost(this.input.allowance.max_roots);
      this.meter.charge(envelope.work_units, envelope.memory_bytes, "source acquisition result envelope");
      this.prepareInput();
      this.stage = "lexical";
      this.loadLexicalPage();
      this.stage = "vector";
      if (this.control !== "lexical") this.scanVectors();
      this.stage = "nomination";
      if (!captureOnly) {
        this.nominateRetainedRoots();
        this.associateStatementWitnesses();
      }
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
    const result = this.result();
    this.observe("acquisition_complete", () => ({ kind: "acquisition_complete", completion: result.completion, accounting: { ...this.counts },
      lexical_completion: this.lexical.completion, vector_completion: this.vector.completion,
      statement_association: this.statements?.availability() ?? { status: "not_requested", reason: "association_not_requested" } }));
    return result;
  }

  private loadLexicalPage(): void {
    if (this.control === "vector") {
      this.lexical = { completion: "not_run", index_coverage: "partial",
        reason: SourceIndexAcquisition.channelNotRequested, limitations: [], tokenization: null };
      return;
    }
    const lexical = this.repository.readLexicalCandidates(this.input.workspace_id, this.input.navigation_text,
      this.input.allowance.max_attempts, this.meter.remaining());
    this.lexicalCandidates = collapseStatementCandidates(lexical.candidates, this.meter);
    this.lexical = { completion: lexical.completion, reason: lexical.reason,
      index_coverage: lexical.index_coverage, limitations: lexical.limitations, tokenization: lexical.tokenization };
    if (lexical.resource_refusal) this.resourceRefusals.push(lexical.resource_refusal);
    this.absorb(lexical.resources);
    observeLexicalCandidates(this.lexicalCandidates, fact => this.observe("lexical_candidate", fact));
  }

  private nominateRetainedRoots(): void {
    const preference = this.input.question_time;
    const cursor = { lexicalIndex: 0, vectorIndex: 0, takeLexical: true };
    // Secure the original prefix before optional time reads can exhaust resources.
    const nativePending = this.nominatePrefix(Boolean(preference?.intervals.length), cursor);
    const domain = preference?.intervals.length ? this.repository.readQuestionTimeDomain?.(
      this.input.workspace_id, preference, [], this.meter.remaining()) : undefined;
    if (domain !== undefined) this.absorb(domain.resources);
    const active = domain?.status === "ready" && domain.exists;
    if (preference?.intervals.length && (domain === undefined || domain.status === "unavailable")) {
      this.limited = true;
      this.resourceRefusals.push({ stage: "nomination", phase: domain?.reason ?? "question_time_reader_unavailable" });
    }
    if (!active && preference?.intervals.length) this.nominatePrefix(false, cursor);
    if (!active) this.observe("source_task_inventory", () => sourceTaskInventory({
      state: preference?.intervals.length && (domain === undefined || domain.status === "unavailable") ? "unavailable" : "inactive",
      reason: preference === undefined ? this.originalQuestionTime === undefined ? "question_time_not_proposed" : "question_time_no_recorded_domain"
        : domain?.status === "unavailable" ? domain.reason : domain === undefined ? "question_time_reader_unavailable" : "question_time_domain_empty",
      restrictedComplete: true, original: [...this.nominations.entries()], nominations: this.nominations, result: this.result() }));
    if (active) this.preferActiveQuestionTime(preference!, nativePending);
  }

  private preferActiveQuestionTime(preference: QuestionTimePreference, nativePending: boolean): void {
    this.limited ||= nativePending;
    const partial = preferQuestionTime({
      repository: this.repository, workspace: this.input.workspace_id,
      navigation: this.input.navigation_text, preference, nominations: this.nominations, counts: this.counts,
      maxRoots: this.input.allowance.max_roots, maxAttempts: this.input.allowance.max_attempts, meter: this.meter,
      absorb: resources => this.absorb(resources), refusals: this.resourceRefusals,
      ordered: keys => { this.questionTimeOrder = keys; },
      observeInventory: (original, restrictedComplete, reason) => this.observe("source_task_inventory", () => sourceTaskInventory({
        state: reason === undefined ? "active" : "unavailable", reason, restrictedComplete,
        sourceId: this.capture?.observationSourceId, original, nominations: this.nominations, result: this.result() })),
      ...this.preferredRetentionHook(),
      ...(this.capture === undefined ? {} : { occurrences: this.capture.retained }),
      nominate: candidates => {
        this.timeRoute = true; this.lexicalCandidates = collapseStatementCandidates(candidates, this.meter); this.vectorCandidates = [];
        observeLexicalCandidates(this.lexicalCandidates, fact => this.observe("lexical_candidate", fact), "question_time");
        const pending = this.nominatePrefix(true); this.limited ||= pending;
      }
    });
    this.limited ||= partial;
  }

  private preferredRetentionHook(): {
    beforeFinalRetention?: (original: readonly (readonly [string, RetainedNomination])[]) => void;
  } {
    const capture = this.capture;
    if (capture?.preferenceRetention === undefined) return {};
    const retention = capture.preferenceRetention;
    const occurrences = capture.retained;
    const shared = (original: readonly (readonly [string, RetainedNomination])[]) => ({
      original, nominations: this.nominations, occurrences,
      max_roots: this.input.allowance.max_roots, repository: this.repository, meter: this.meter,
      retention, association: this.associationProtection(original),
      result: () => this.result(), nativeBytes: (bytes: number) => { this.nativeBytes += bytes; }
    });
    const template = this.input.source_template;
    if (template !== undefined) {
      return {
        beforeFinalRetention: original => {
          this.prepaidBaseBytes = restoreSourceTemplate({
            ...shared(original), proposal: template,
            observe: observation => this.observe("source_template_restoration", () => ({
              kind: "source_template_restoration", observation, index_binding: this.vectorBinding
            }))
          });
        }
      };
    }
    const observation = this.input.source_task_observation;
    const question = this.originalQuestionTime;
    if (observation !== undefined && question !== undefined) {
      return {
        beforeFinalRetention: original => {
          this.prepaidBaseBytes = preferTaskObservations({
            ...shared(original), proposal: observation, question, query: this.input.navigation_text,
            observe: inspected => this.observe("source_task_observation", () => ({
              kind: "source_task_observation", observation: inspected
            }))
          });
        }
      };
    }
    return {};
  }

  private associationProtection(original: readonly (readonly [string, RetainedNomination])[]): SourceSemanticResourceBudget {
    return this.statements?.finalizationProtection(this.input.allowance.max_roots,
      original.reduce((sum, [key]) => sum + key.length, 0)
        + [...this.nominations.keys()].reduce((sum, key) => sum + key.length, 0))
      ?? { work_units: 0, memory_bytes: 0 };
  }

  /** Native snapshot owns the witness read; association scores only those facts and absorbs measured resources. */
  private associateStatementWitnesses(): void {
    this.association = this.statements?.associate([...this.nominations.keys()], (root, keys, anchors) => {
      const read = this.repository.readStatementWitnesses?.(this.nominations.get(root)!.source, keys, anchors, this.meter.remaining());
      if (read !== undefined) this.absorb(read.resources);
      return read;
    }, evidenceWindow(this.originalQuestionTime));
  }

  private result(): SourceIndexAcquisitionResult {
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
        "lexical_corpus_coverage_untracked", ...(this.timeRoute ? ["question_time_bounded_preference"] : [])]
    };
  }

  private observe(kind: SourceIndexAcquisitionFact["kind"], capture: () => SourceIndexAcquisitionFact): void {
    try { this.observer?.(capture, kind); } catch { /* Observer failure cannot alter nomination, budget or output. */ }
  }

  private observeNomination(channel: "lexical" | "vector", source: SourceIndexTarget,
    disposition: Extract<SourceIndexAcquisitionFact, { kind: "nomination_attempt" }>["disposition"],
    admission?: NativeAdmissionFact, mergeTarget?: SourceIndexTarget["target"],
    resourceRefusal?: QueryResourceRefusal): void {
    this.observe("nomination_attempt", () => ({ kind: "nomination_attempt", channel,
      target: structuredClone(source.target), disposition,
      ...(admission === undefined ? {} : { admission }),
      ...(mergeTarget === undefined ? {} : { merge_target: structuredClone(mergeTarget) }),
      ...(resourceRefusal === undefined ? {} : { resource_refusal: { ...resourceRefusal } }) }));
  }

  private prepareInput(): void {
    this.meter.retain(this.input.navigation_text, "source navigation capture");
    const digest = acquisitionNavigationDigestCost(this.input.navigation_text);
    this.meter.charge(digest.work_units, digest.memory_bytes, "source navigation digest");
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
    const binding = acquisitionQueryBindingCost();
    this.meter.charge(binding.work_units, binding.memory_bytes, "source query binding");
    if (sourceIndexProfileId(parsed.data, this.sha256) !== vector.profile_id) {
      this.unavailableVector("profile_binding_mismatch"); return;
    }
    if (vector.input_digest !== this.navigationDigest) { this.unavailableVector("input_binding_mismatch"); return; }
    const dimensions = parsed.data.dimensions;
    const capture = acquisitionQueryVectorNormCost(dimensions);
    this.meter.charge(capture.work_units, capture.memory_bytes, "source query vector capture, validation and norm");
    if (!(vector.embedding instanceof Float32Array) || vector.embedding.length !== dimensions || !isFiniteNonzeroVector(vector.embedding)) {
      this.unavailableVector("invalid_query_vector"); return;
    }
    this.queryVector = new Float32Array(vector.embedding);
    this.scoreVector = createValidatedCosineBatchScorer(this.queryVector);
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
      this.meter.charge(VECTOR_COST.ordering_work, VECTOR_COST.ordering_bytes
        + best.size * VECTOR_COST.ordering_reference_bytes, "source vector root ordering");
      const ranked = [...best.values()];
      ranked.sort((left, right) => {
        this.meter.charge(VECTOR_COST.comparison_work, 0, "source vector root comparison");
        return right.vector.cosine - left.vector.cosine || compareKey(left.source.root_key, right.source.root_key) ||
          compareKey(left.vector.window.window_id, right.vector.window.window_id);
      });
      const retained = ranked.map((candidate, index) => {
        this.meter.charge(VECTOR_COST.rank_work, VECTOR_COST.rank_bytes, "source vector rank retention");
        return { ...candidate, vector: { ...candidate.vector, rank: index + 1 } };
      });
      // Publish only after the whole ranked set is retained. A later meter refusal discards this map.
      this.vectorCandidates = retained;
      for (const rankedCandidate of retained) {
        this.observe("vector_ranked", () => ({ kind: "vector_ranked", target: structuredClone(rankedCandidate.source.target),
          window: structuredClone(rankedCandidate.vector.window), cosine: rankedCandidate.vector.cosine,
          rank: rankedCandidate.vector.rank }));
      }
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
    this.meter.charge(VECTOR_COST.validation_per_dimension * dimensions, 0, "source vector validation and cosine");
    const cosine = this.scoreVector!(candidate.embedding);
    if (cosine === null) {
      this.vector = { ...this.vector, completion: "partial", reason: "invalid_vectors",
        invalid_windows: this.vector.invalid_windows + 1 }; return;
    }
    if (!Number.isFinite(cosine)) return;
    if (candidate.source.auxiliary !== undefined) this.statements?.consider(sourceIndexNativeRootKey(candidate.source), cosine, candidate.embedding, candidate.source);
    this.observe("vector_inspected", () => ({ kind: "vector_inspected", target: structuredClone(candidate.source.target),
      window: structuredClone(candidate.window), cosine }));
    const key = this.capture?.grouped === true ? candidate.window.window_id : sourceIndexNativeRootKey(candidate.source);
    // Both keys are captured by the native reader. Reuse their identities rather
    // than reconstructing the same canonical root for every vector window.
    this.meter.charge(VECTOR_COST.lookup_work, 0, "source vector root lookup");
    const previous = best.get(key);
    if (previous !== undefined && (previous.vector.cosine > cosine || previous.vector.cosine === cosine &&
        compareKey(previous.vector.window.window_id, candidate.window.window_id) <= 0)) return;
    this.meter.charge(VECTOR_COST.replacement_work, VECTOR_COST.replacement_bytes
      + VECTOR_COST.key_bytes_per_character * key.length, "source vector best-window retention");
    best.set(key, { source: candidate.source, vector: { rank: 0, cosine, window: candidate.window } });
  }

  private nominatePrefix(stopAtRootLimit = false,
    cursor = { lexicalIndex: 0, vectorIndex: 0, takeLexical: true }): boolean {
    let { lexicalIndex, vectorIndex, takeLexical } = cursor;
    while ((!stopAtRootLimit || this.nominations.size < this.input.allowance.max_roots)
      && this.counts.attempted < this.input.allowance.max_attempts &&
        (lexicalIndex < this.lexicalCandidates.length || vectorIndex < this.vectorCandidates.length)) {
      const lexicalTurn: boolean = lexicalIndex < this.lexicalCandidates.length &&
        (takeLexical || vectorIndex >= this.vectorCandidates.length);
      takeLexical = !lexicalTurn;
      const lexical = lexicalTurn ? this.lexicalCandidates[lexicalIndex++]! : null;
      const vector = lexicalTurn ? null : this.vectorCandidates[vectorIndex++]!;
      const source = lexical?.source ?? vector!.source;
      const channel = lexicalTurn ? "lexical" as const : "vector" as const;
      this.stage = "nomination";
      this.meter.charge(1, 0, "source nomination attempt");
      this.counts.attempted++;
      if (this.capture !== undefined) this.capture.progress[channel]++;
      this.stage = "admission";
      try {
        const admission = this.admit(source, vector === null ? null : this.vectorBinding);
        this.absorb(admission.resources);
        if (admission.status !== "ready") {
          this.counts.rejected++;
          if (admission.status === "resource_limited") {
            this.counts.resource_refused++;
            const refusal: QueryResourceRefusal = { stage: "admission", phase: admission.phase };
            this.resourceRefusals.push(refusal);
            this.observeNomination(channel, source, "resource_refused",
              { status: admission.status, reason: admission.reason, phase: admission.phase }, undefined, refusal);
            this.limited = true; break;
          }
          const native = { status: admission.status, reason: admission.reason };
          if (admission.status === "stale") {
            this.counts.stale++;
            this.observeNomination(channel, source, "stale", native);
            continue;
          }
          this.counts.native_unknown++;
          this.observeNomination(channel, source, "native_unknown", native);
          continue;
        }
        this.meter.charge(1 + (admission.scope_class?.length ?? 0), 0, "source scope admission");
        const scope = this.admitScope(admission.scope_class, source);
        if (scope === "denied") {
          this.counts.rejected++; this.counts.scope_denied++;
          this.observeNomination(channel, source, "scope_denied"); continue;
        }
        if (scope !== "admitted") throw new CoreError("VALIDATION", "invalid source scope admission result");
        this.stage = "nomination";
        this.retainNomination(channel, source, lexical?.lexical ?? null, vector?.vector ?? null);
      } catch (error) {
        // A thrown admission leaves this attempt unsettled, not a native-unknown result.
        if (this.counts.attempted > this.counts.admitted + this.counts.duplicate + this.counts.rejected) {
          this.counts.rejected++;
        }
        const resource = error instanceof SourceSemanticResourceExhausted;
        if (!resource) {
          this.observeNomination(channel, source, "rejected");
          throw error;
        }
        const refusal: QueryResourceRefusal = { stage: this.stage, phase: error.phase };
        this.observeNomination(channel, source, "resource_refused", undefined, undefined, refusal);
        this.counts.resource_refused++;
        this.resourceRefusals.push(refusal);
        this.limited = true; break;
      }
    }
    Object.assign(cursor, { lexicalIndex, vectorIndex, takeLexical });
    const pending = lexicalIndex < this.lexicalCandidates.length || vectorIndex < this.vectorCandidates.length;
    if (!stopAtRootLimit) this.limited ||= pending;
    return pending;
  }

  /** One snapshot decides a root once per binding mode; a resource-limited result is never reused. */
  private admit(source: SourceIndexTarget, binding: SourceIndexVectorBinding | null): SourceIndexQueryAdmission {
    const decided = binding === null ? this.unboundAdmissions : this.boundAdmissions;
    const previous = decided.get(source.root_key);
    if (previous !== undefined) {
      this.meter.charge(1, 0, "source admission reuse");
      return { ...previous, resources: { work: 0, native_bytes: 0, memory_bytes: 0, sql_internal_work: "unknown" } };
    }
    const admission = this.repository.admitQueryCandidate(source, binding, this.meter.remaining());
    if (admission.status !== "resource_limited") {
      this.meter.charge(0, 64, "source admission reuse retention");
      decided.set(source.root_key, admission);
    }
    return admission;
  }

  private retainNomination(channel: "lexical" | "vector", source: SourceIndexTarget,
    lexical: SourceIndexLexicalRank | null, vector: SourceIndexRootNomination["vector"]): void {
    // Admission owns canonical target validation. Reuse that admitted identity;
    // reconstructing it here copies and scans a key already retained by the reader.
    if (this.timeRoute && lexical !== null) {
      lexical = { ...lexical, domain: "question_time" };
      this.meter.retain(lexical, "restricted lexical rank provenance");
    }
    const key = sourceIndexNativeRootKey(source), previous = this.nominations.get(key);
    if (previous !== undefined) {
      this.meter.charge(1, lexical === null ? 0 : 8, "source nomination overlap");
      this.retainOccurrence(source, lexical, vector);
      if (lexical !== null) previous.lexical.push(lexical);
      if (vector !== null && previous.source.root_key === source.root_key) previous.vector = vector;
      this.counts.duplicate++;
      this.observeNomination(channel, source, "duplicate", undefined, previous.source.target); return;
    }
    if (this.nominations.size >= this.input.allowance.max_roots) {
      this.counts.rejected++; this.counts.nomination_limit++; this.limited = true;
      this.observeNomination(channel, source, "nomination_limit");
      this.retainIndexMember(key, source); return;
    }
    this.meter.charge(1, 192, "source nomination reference retention");
    this.retainOccurrence(source, lexical, vector);
    this.nominations.set(key, { source, lexical: lexical === null ? [] : [lexical], vector });
    this.counts.admitted++;
    this.observeNomination(channel, source, "admitted");
  }

  /** Bounded by the requested count and kept off the ledger the nominated prefix and association share. */
  private retainIndexMember(key: string, source: SourceIndexTarget): void {
    if (this.indexMembers.length >= (this.capture?.indexMembers ?? 0) || this.indexMemberKeys.has(key)) return;
    this.indexMemberKeys.add(key); this.indexMembers.push(source);
  }

  private retainOccurrence(source: SourceIndexTarget, lexical: SourceIndexLexicalRank | null,
    vector: SourceIndexRootNomination["vector"]): void {
    const capture = this.capture;
    if (capture === undefined) return;
    const view = capture.view;
    const route: SourceSemanticNominationOccurrence["route"] = lexical !== null
      ? { kind: "lexical", native_rank: lexical.rank, lane: lexical.lane, lane_rank: lexical.lane_rank, bm25: lexical.bm25 }
      : { kind: "vector", native_rank: vector!.rank, cosine: vector!.cosine,
        window: { status: "available", window: vector!.window } };
    const metadata = { reference: `${view}:${this.timeRoute ? "question-time:" : ""}${route.kind}:${route.native_rank}`,
      attempt: this.counts.attempted, view, route,
      ...(lexical?.domain === undefined ? {} : { domain: lexical.domain }) };
    this.meter.retain(metadata, "source retained nomination occurrence");
    // The native reader already owns and charges the immutable source graph.
    // Attach its reference after measuring the newly allocated metadata, rather
    // than traversing that same graph again for each lexical/vector occurrence.
    this.meter.charge(1, 8, "source retained occurrence source reference");
    capture.retained.push(Object.assign(metadata, { source }));
  }

  private absorb(resources: SourceIndexQueryResources): void {
    this.meter.charge(resources.work, resources.memory_bytes, "source index bounded native phase");
    this.nativeBytes += resources.native_bytes;
  }
}

function compareKey(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
