import {
  BoundedIdSchema, SourceIndexProfileSchema, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  canonicalJson, hashContentDigest, sourceGoldRootIdentity, sourceIndexProfileId,
  type FieldContractSha256, type SourceIndexAcquisitionInput, type SourceIndexAcquisitionResult,
  type SourceIndexLexicalCandidate, type SourceIndexLexicalRank, type SourceIndexNominationAccounting,
  type SourceIndexQueryRepository, type SourceIndexQueryResources, type SourceIndexRootNomination,
  type SourceIndexScopeAdmission, type SourceIndexTarget, type SourceIndexVectorBinding, type SourceIndexVectorCandidate,
  type SourceIndexVectorCursor
} from "@do-soul/alaya-protocol";
import { createCosineBatchScorer, isFiniteNonzeroVector } from "../embedding-recall/helpers.js";
import { CoreError } from "../shared/errors.js";

type QueryResourceRefusal = SourceIndexAcquisitionResult["resource_refusals"][number];
type ScoredRoot = Readonly<{
  source: SourceIndexTarget; vector: NonNullable<SourceIndexRootNomination["vector"]>;
}>;
type RetainedNomination = {
  source: SourceIndexTarget; lexical: SourceIndexLexicalRank[]; vector: SourceIndexRootNomination["vector"];
};

/** Production acquisition policy, intended for observeSourceSemanticAccess (prepare and library).
 * Call inside the caller-owned native read snapshot; this owner does not create a snapshot lease.
 * It does not run inference, read bodies, select delivery packages or publish public receipts.
 */
export class SourceIndexAcquisition {
  public constructor(private readonly repository: SourceIndexQueryRepository, private readonly sha256: FieldContractSha256) {}

  public nominate(input: SourceIndexAcquisitionInput, admitScope: SourceIndexScopeAdmission): SourceIndexAcquisitionResult {
    validateInput(input, admitScope);
    const captured = { ...input, allowance: { ...input.allowance }, budget: { ...input.budget } };
    return new AcquisitionQuery(this.repository, this.sha256, captured, admitScope).run();
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
    private readonly input: SourceIndexAcquisitionInput, private readonly admitScope: SourceIndexScopeAdmission) {
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
      const lexical = this.repository.readLexicalCandidates(this.input.workspace_id, this.input.navigation_text,
        this.input.allowance.max_attempts, this.meter.remaining());
      this.lexicalCandidates = lexical.candidates;
      this.lexical = { completion: lexical.completion, reason: lexical.reason,
        index_coverage: lexical.index_coverage, limitations: lexical.limitations, tokenization: lexical.tokenization };
      if (lexical.resource_refusal) this.resourceRefusals.push(lexical.resource_refusal);
      this.absorb(lexical.resources);
      this.stage = "vector"; this.scanVectors();
      this.stage = "nomination"; this.nominatePrefix();
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      this.resourceRefusals.push({ stage: this.stage, phase: error.phase });
      if (this.stage === "input" && this.vector.completion === "not_run") {
        this.vector = { ...this.vector, reason: "read_budget" };
      }
      this.limited = true;
    }
    const complete = !this.limited && this.counts.native_unknown === 0 && this.lexical.completion === "complete" &&
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
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        this.counts.rejected++; this.counts.resource_refused++;
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
