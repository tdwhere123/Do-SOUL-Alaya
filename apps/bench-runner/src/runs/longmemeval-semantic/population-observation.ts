import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { isContainedPath } from "../fs/opened-contained-path.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../semantic-chain/contract.js";
import { admitLazyFinal, admitLazyWindow, readLazyQualifiedExposureState } from "../semantic-chain/lazy-qualification.js";
import { materializeSemanticProposalLines } from "../semantic-proposal/workset.js";
import { admitLongMemEvalLazyConfig } from "./lazy-config.js";
import { admitLongMemEvalLazyMeasurement, measureLongMemEvalLazyFirstExposure } from "./lazy-measure.js";
import { summarizeLongMemEvalOutcomes } from "./measure.js";
import { admitNativeFreeze, PopulationSchema, readLongMemEvalLazyPopulation,
  STAGES, StageRecordSchema, stageRecord, type Population } from "./population.js";
import { inspectPopulationAttemptScopes, PopulationAttemptEvidenceSchema, PopulationAttemptScopeSchema,
  type PopulationAttemptScope } from "./population-attempts.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ProducerCoverageSchema = z.object({ frozen_members: z.number().int().nonnegative(),
  members_with_scopes: z.number().int().nonnegative(), members_without_scopes: z.number().int().nonnegative(),
  members_with_scope_error: z.number().int().nonnegative(), population_attempt_coverage_complete: z.boolean(),
  population_authorized_attempts: z.number().int().nonnegative().nullable() }).strict();
const ObservationInputSchema = z.object({ cutoff_id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/u),
  cutoff_at: z.string().datetime(), predecessor_identity: Digest.nullable() }).strict();
const CutoffSchema = ObservationInputSchema.extend({
  contract: z.literal("longmemeval-lazy-population-cutoff-v1"), population_identity: Digest,
  captured_at: z.string().datetime(), members: z.array(z.object({ member: PopulationSchema.shape.members.element,
    stages: z.array(z.object({ stage: z.enum(STAGES), requested: StageRecordSchema.nullable(),
      completed: StageRecordSchema.nullable(), failed: StageRecordSchema.nullable() }).strict()),
    exposure_identity: Digest.nullable(), capture_error: z.string().nullable(),
    attempt_scopes: z.array(PopulationAttemptScopeSchema), attempt_scope_error: z.string().nullable() }).strict()),
  producer_evidence: PopulationAttemptEvidenceSchema.nullable(), producer_evidence_error: z.string().nullable(),
  producer_coverage: ProducerCoverageSchema
}).strict();
const ObservationSchema = ObservationInputSchema.extend({
  contract: z.literal("longmemeval-lazy-population-observation-v1"), population_identity: Digest,
  cutoff_identity: Digest, captured_at: z.string().datetime(),
  producer_evidence: PopulationAttemptEvidenceSchema.nullable(), producer_evidence_error: z.string().nullable(),
  producer_coverage: ProducerCoverageSchema,
  population: z.enum(["development20", "reused_readiness50"]), selection: z.unknown(),
  metric: z.literal("source-bearing-union-first-exposure-any-at-k-v1"),
  status: z.literal("development_only"), formal_target: z.literal("not_run"),
  inventory: z.object({ selected: z.number().int().nonnegative(), answerable: z.number().int().nonnegative(),
    abstention: z.number().int().nonnegative(), original_questions: z.literal(500) }).strict(),
  primary: z.object({ eligible: z.number().int().nonnegative(), hits: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(),
    lower_bound: z.number().nullable(), upper_bound: z.number().nullable() }).strict(),
  rows: z.array(z.object({ question_id: z.string(), index: z.number().int(),
    cohort: z.enum(["answerable", "abstention"]), prior_development_exposure: z.boolean(),
    outcome: z.enum(["hit", "miss", "unknown", "uncalibrated"]), boundary: z.string(),
    measurement_path: z.string().nullable(), first_exposure_identity: Digest.nullable(),
    native_root: z.string(), lazy_root: z.string(), evaluator_root: z.string(),
    attempt_scopes: z.array(PopulationAttemptScopeSchema), attempt_scope_error: z.string().nullable(),
    stages: z.array(z.object({ stage: z.enum(STAGES), requested: Digest.nullable(),
      completed: Digest.nullable(), failed: Digest.nullable(), native_path: z.string().nullable(),
      native_identity: Digest.nullable() }).strict()) }).strict())
}).strict();

async function readOrFreezeCutoff(root: string, input: z.infer<typeof ObservationInputSchema>, population: Population,
  populationIdentity: string, allowCreate: boolean) {
  const path = join(root, `population-cutoff-${input.cutoff_id}.json`);
  const existing = readChainArtifact(path);
  if (existing !== undefined) {
    const cutoff = CutoffSchema.parse(existing);
    if (cutoff.population_identity !== populationIdentity ||
        canonicalJson({ cutoff_id: cutoff.cutoff_id, cutoff_at: cutoff.cutoff_at,
          predecessor_identity: cutoff.predecessor_identity }) !== canonicalJson(input) ||
        canonicalJson(cutoff.members.map(row => row.member)) !== canonicalJson(population.members)) {
      throw new AlayaError("CONFLICT", "retained cutoff belongs to another population or member set");
    }
    return cutoff;
  }
  if (!allowCreate) throw new AlayaError("CONFLICT", "retained population observation lost its cutoff artifact");
  const members = [];
  for (const member of population.members) {
    try {
      const stages = STAGES.map(stage => ({ stage,
        requested: stageRecord(root, member, stage, "requested", populationIdentity) ?? null,
        completed: stageRecord(root, member, stage, "completed", populationIdentity) ?? null,
        failed: stageRecord(root, member, stage, "failed", populationIdentity) ?? null }));
      const exposure = readChainArtifact(join(member.lazy_root, "first-exposure.json"));
      const scopes: PopulationAttemptScope[] = [];
      let attemptScopeError: string | null = null;
      try {
        if (readChainArtifact(join(member.native_root, "freeze.json")) !== undefined) {
          const frozen = admitNativeFreeze(member, population);
          scopes.push({ layer: "query", cacheRoot: frozen.config.query_cache_root,
            model: frozen.config.model, requestProfile: frozen.config.request_profile,
            keys: [frozen.selected[0]!.query_key] });
        }
        if (readChainArtifact(join(member.lazy_root, "window.json")) !== undefined) {
          const { window } = await admitLazyWindow(member.lazy_root);
          scopes.push({ layer: "source", cacheRoot: member.source_cache_root,
            model: window.config.source_population.model,
            requestProfile: window.config.source_population.requestProfile,
            keys: window.selected_missing_keys });
        }
        if (readChainArtifact(join(member.lazy_root, "final.json")) !== undefined) {
          const { plan } = await admitLazyFinal(member.lazy_root);
          scopes.push({ layer: "correspondence",
            cacheRoot: plan.config.correspondence_cache_root,
            model: plan.correspondence_workset?.model ?? plan.config.query_workset.model,
            requestProfile: plan.correspondence_workset?.request_profile ?? plan.config.query_workset.request_profile,
            keys: plan.correspondence_workset === null ? [] : materializeSemanticProposalLines(
              plan.correspondence_workset, plan.config.max_output_tokens).map(line => line.key) });
        }
        inspectPopulationAttemptScopes(scopes);
      } catch (error) { attemptScopeError = error instanceof Error ? error.message : String(error); }
      members.push({ member, stages, exposure_identity: exposure === undefined ? null : chainIdentity(exposure),
        capture_error: null, attempt_scopes: scopes, attempt_scope_error: attemptScopeError });
    } catch (error) { members.push({ member, stages: [], exposure_identity: null,
      capture_error: error instanceof Error ? error.message : String(error),
      attempt_scopes: [], attempt_scope_error: null }); }
  }
  let producerEvidence: z.infer<typeof PopulationAttemptEvidenceSchema> | null = null;
  let producerEvidenceError: string | null = null;
  try { producerEvidence = inspectPopulationAttemptScopes(members.filter(row => row.attempt_scope_error === null)
    .flatMap(row => row.attempt_scopes)); }
  catch (error) { producerEvidenceError = error instanceof Error ? error.message : String(error); }
  const layers: readonly PopulationAttemptScope["layer"][] = ["query", "source", "correspondence"];
  const membersWithScopes = members.filter(row => row.attempt_scope_error === null && row.capture_error === null &&
    layers.every(layer => row.attempt_scopes.some(scope => scope.layer === layer))).length;
  const coverageComplete = membersWithScopes === population.members.length &&
    producerEvidence?.inspected_scope_history_complete === true && producerEvidenceError === null;
  const producerCoverage = ProducerCoverageSchema.parse({ frozen_members: population.members.length,
    members_with_scopes: membersWithScopes, members_without_scopes: population.members.length - membersWithScopes,
    members_with_scope_error: members.filter(row => row.attempt_scope_error !== null || row.capture_error !== null).length,
    population_attempt_coverage_complete: coverageComplete,
    population_authorized_attempts: coverageComplete ? producerEvidence?.scoped_authorized_attempts ?? null : null });
  const cutoff = CutoffSchema.parse({ ...input, contract: "longmemeval-lazy-population-cutoff-v1",
    population_identity: populationIdentity, captured_at: new Date().toISOString(), members,
    producer_evidence: producerEvidence, producer_evidence_error: producerEvidenceError,
    producer_coverage: producerCoverage });
  writeChainArtifact(path, cutoff);
  return cutoff;
}

async function admitObservation(result: z.infer<typeof ObservationSchema>, population: Population,
  populationIdentity: string, cutoff: z.infer<typeof CutoffSchema>, revalidateMetric: boolean) {
  const rows = result.rows;
  if (result.population_identity !== populationIdentity || result.cutoff_identity !== chainIdentity(cutoff) ||
      result.captured_at !== cutoff.captured_at || result.population !== population.population ||
      canonicalJson(result.producer_evidence) !== canonicalJson(cutoff.producer_evidence) ||
      result.producer_evidence_error !== cutoff.producer_evidence_error ||
      canonicalJson(result.producer_coverage) !== canonicalJson(cutoff.producer_coverage) ||
      canonicalJson(result.selection) !== canonicalJson(population.selection) ||
      rows.length !== population.members.length || rows.some((row, index) => {
        const member = population.members[index]!;
        return row.question_id !== member.question_id || row.index !== member.index ||
          row.cohort !== member.dataset_cohort ||
          row.prior_development_exposure !== member.prior_development_exposure ||
          row.native_root !== member.native_root || row.lazy_root !== member.lazy_root ||
          row.evaluator_root !== member.evaluator_root ||
          canonicalJson(row.attempt_scopes) !== canonicalJson(cutoff.members[index]?.attempt_scopes) ||
          row.attempt_scope_error !== cutoff.members[index]?.attempt_scope_error ||
          row.first_exposure_identity !== null && row.first_exposure_identity !== cutoff.members[index]?.exposure_identity ||
          canonicalJson(row.stages) !== canonicalJson(cutoff.members[index]?.stages.map(stage => ({
            stage: stage.stage, requested: stage.requested === null ? null : chainIdentity(stage.requested),
            completed: stage.completed === null ? null : chainIdentity(stage.completed),
            failed: stage.failed === null ? null : chainIdentity(stage.failed),
            native_path: stage.completed?.result_path ?? null,
            native_identity: stage.completed?.result_identity ?? null })));
      }) || canonicalJson(result.primary) !== canonicalJson(summarizeLongMemEvalOutcomes(rows)) ||
      result.inventory.selected !== rows.length ||
      result.inventory.answerable !== result.primary.eligible ||
      result.inventory.abstention !== rows.length - result.primary.eligible ||
      result.inventory.original_questions !== population.dataset_question_count) {
    throw new AlayaError("CONFLICT", "retained population observation lost its fixed denominator or native bindings");
  }
  for (const [index, row] of rows.entries()) {
    if (row.measurement_path === null) {
      if (row.outcome === "hit" || row.outcome === "miss") throw new AlayaError("CONFLICT", "scored member lacks native measurement");
      continue;
    }
    const member = population.members[index]!;
    if (!isContainedPath(member.evaluator_root, row.measurement_path) ||
        row.first_exposure_identity === null ||
        row.first_exposure_identity !== cutoff.members[index]?.exposure_identity) {
      throw new AlayaError("CONFLICT", "member measurement path or first exposure changed");
    }
    if (!revalidateMetric) continue;
    const input = { root: member.native_root,
      preparedPath: cutoff.members[index]!.stages.find(stage => stage.stage === "prepare")?.completed?.result_path ?? "",
      sourcePreflightPath: member.source_preflight_path, sourceCacheRoot: member.source_cache_root,
      lazyRoot: member.lazy_root, evaluatorRoot: member.evaluator_root };
    const measurement = (await admitLongMemEvalLazyMeasurement(input, row.measurement_path)).result;
    if (measurement === undefined || measurement.contract !== "longmemeval-lazy-semantic-measurement-v1") {
      throw new AlayaError("CONFLICT", "native lazy measurement is missing or foreign");
    }
    if (measurement.question_id !== row.question_id || measurement.question_index !== row.index ||
        measurement.first_exposure_identity !== row.first_exposure_identity ||
        measurement.rows.find(native => native.question_id === row.question_id && native.selected)?.outcome !== row.outcome) {
      throw new AlayaError("CONFLICT", "retained member metric differs from native isolated evaluator");
    }
  }
  return result;
}

/** Samples frozen native references first; absent or rejected stages remain in the fixed denominator. */
export async function observeLongMemEvalLazyPopulation(root: string, value: unknown) {
  const input = ObservationInputSchema.parse(value);
  const path = join(root, `population-observation-${input.cutoff_id}.json`);
  const population = readLongMemEvalLazyPopulation(root), populationIdentity = chainIdentity(population);
  return withSnapshotPublishLock(join(root, "population-observations"), async () => {
  const retained = readChainArtifact(path);
  if (retained !== undefined) {
    const result = ObservationSchema.parse(retained);
    const cutoff = await readOrFreezeCutoff(root, input, population, populationIdentity, false);
    if (result.population_identity !== populationIdentity ||
        canonicalJson({ cutoff_id: result.cutoff_id, cutoff_at: result.cutoff_at,
          predecessor_identity: result.predecessor_identity }) !== canonicalJson(input)) {
      throw new AlayaError("CONFLICT", "population cutoff label already binds another observation");
    }
    return { path, result: await admitObservation(result, population, populationIdentity, cutoff, true) };
  }
  const priorPaths = existsSync(root) ? readdirSync(root).filter(name => /^population-observation-[a-zA-Z0-9_-]+\.json$/u.test(name)) : [];
  const prior = [];
  for (const name of priorPaths) {
    const observation = ObservationSchema.parse(readChainArtifact(join(root, name)));
    const priorCutoff = await readOrFreezeCutoff(root, {
      cutoff_id: observation.cutoff_id, cutoff_at: observation.cutoff_at,
      predecessor_identity: observation.predecessor_identity
    }, population, populationIdentity, false);
    prior.push(await admitObservation(observation, population, populationIdentity, priorCutoff, true));
  }
  const predecessorIds = new Set(prior.map(row => row.predecessor_identity));
  const tips = prior.filter(row => !predecessorIds.has(chainIdentity(row)));
  if (prior.length === 0 ? input.predecessor_identity !== null :
      tips.length !== 1 || input.predecessor_identity !== chainIdentity(tips[0])) {
    throw new AlayaError("CONFLICT", "population observation predecessor does not bind a retained cutoff");
  }
  const cutoff = await readOrFreezeCutoff(root, input, population, populationIdentity, true);
  const captured = cutoff.members;
  const rows = [];
  for (const capture of captured) {
    const { member, stages } = capture;
    let outcome: "hit" | "miss" | "unknown" | "uncalibrated" = member.dataset_cohort === "abstention" ? "uncalibrated" : "unknown";
    let boundary = capture.capture_error ?? "execution_state_unknown";
    if (capture.attempt_scope_error !== null || cutoff.producer_evidence_error !== null) {
      boundary = `producer_evidence_unknown: ${capture.attempt_scope_error ?? cutoff.producer_evidence_error}`;
    }
    let measurementPath: string | null = null, exposureIdentity: string | null = null;
    const stageRefs = stages.map(row => ({ stage: row.stage,
      requested: row.requested === null ? null : chainIdentity(row.requested),
      completed: row.completed === null ? null : chainIdentity(row.completed),
      failed: row.failed === null ? null : chainIdentity(row.failed),
      native_path: row.completed?.result_path ?? null,
      native_identity: row.completed?.result_identity ?? null }));
    if (capture.capture_error === null && capture.attempt_scope_error === null && cutoff.producer_evidence_error === null) {
      const broken = stages.find(row => row.completed === null && (row.failed !== null || row.requested !== null));
      if (broken !== undefined) boundary = broken.failed === null ? `${broken.stage}_effect_unknown` : `${broken.stage}_failed: ${broken.failed.reason}`;
      else if (member.execution_policy === "held" && stages.every(row => row.requested === null)) boundary = "not_started_held";
      else if (stages.find(row => row.stage === "final")?.completed === null) boundary = "final_not_sealed";
      else {
        try {
          const prepare = stages.find(row => row.stage === "prepare")?.completed;
          if (prepare?.result_path === null || prepare?.result_path === undefined) throw new AlayaError("CONFLICT", "prepared member path missing");
          for (const stage of stages) {
            if (stage.completed?.result_path === null || stage.completed?.result_path === undefined) continue;
            const retainedStage = stage.stage === "bind"
              ? JSON.parse(readBoundedCanonicalUtf8Artifact({ path: stage.completed.result_path,
                maxBytes: 1024 * 1024, label: "bound lazy question config" }))
              : readChainArtifact(stage.completed.result_path);
            if (retainedStage === undefined || chainIdentity(retainedStage) !== stage.completed.result_identity) {
              throw new AlayaError("CONFLICT", `${stage.stage} native stage changed after population completion`);
            }
          }
          admitNativeFreeze(member, population);
          const first = await readLazyQualifiedExposureState(member.lazy_root);
          const bound = await admitLongMemEvalLazyConfig({ root: member.native_root,
            preparedPath: prepare.result_path, sourcePreflightPath: member.source_preflight_path,
            sourceCacheRoot: member.source_cache_root });
          if (chainIdentity(first.window.config) !== chainIdentity(bound.config)) throw new AlayaError("CONFLICT", "foreign lazy question binding");
          boundary = first.status === "durable" ? "durable_first_exposure" :
            first.status === "reserved_unknown" ? "first_exposure_reserved_unknown" : "first_exposure_unattempted";
          if (capture.exposure_identity === null && first.status === "durable") {
            boundary = "first_exposure_not_durable_at_cutoff";
          } else if (first.status === "durable") {
            exposureIdentity = chainIdentity(first.exposure);
            if (exposureIdentity !== capture.exposure_identity) throw new AlayaError("CONFLICT", "first exposure changed during population cutoff");
            const measured = await measureLongMemEvalLazyFirstExposure({ root: member.native_root,
              preparedPath: prepare.result_path, sourcePreflightPath: member.source_preflight_path,
              sourceCacheRoot: member.source_cache_root, lazyRoot: member.lazy_root,
              evaluatorRoot: member.evaluator_root });
            const measuredRow = measured.result.rows.find(row => row.question_id === member.question_id && row.selected);
            if (measured.result.question_index !== member.index || measuredRow === undefined ||
                measured.result.first_exposure_identity !== exposureIdentity ||
                measuredRow.outcome !== "hit" && measuredRow.outcome !== "miss" && measuredRow.outcome !== "unknown" &&
                measuredRow.outcome !== "uncalibrated") throw new AlayaError("CONFLICT", "foreign lazy measurement result");
            outcome = member.dataset_cohort === "abstention" ? "uncalibrated" : measuredRow.outcome;
            measurementPath = measured.path;
            boundary = measuredRow.reason ?? boundary;
          }
        } catch (error) { boundary = `member_admission_or_measurement_failed: ${error instanceof Error ? error.message : String(error)}`; }
      }
    }
    rows.push({ question_id: member.question_id, index: member.index,
      cohort: member.dataset_cohort, prior_development_exposure: member.prior_development_exposure,
      outcome, boundary, measurement_path: measurementPath, first_exposure_identity: exposureIdentity,
      native_root: member.native_root, lazy_root: member.lazy_root, evaluator_root: member.evaluator_root,
      attempt_scopes: capture.attempt_scopes, attempt_scope_error: capture.attempt_scope_error,
      stages: stageRefs });
  }
  const primary = summarizeLongMemEvalOutcomes(rows);
  const result = ObservationSchema.parse({ contract: "longmemeval-lazy-population-observation-v1", population_identity: populationIdentity,
    cutoff_identity: chainIdentity(cutoff), captured_at: cutoff.captured_at,
    producer_evidence: cutoff.producer_evidence, producer_evidence_error: cutoff.producer_evidence_error,
    producer_coverage: cutoff.producer_coverage,
    population: population.population, cutoff_id: input.cutoff_id, cutoff_at: input.cutoff_at,
    predecessor_identity: input.predecessor_identity, selection: population.selection,
    metric: population.metric, status: "development_only", formal_target: "not_run",
    inventory: { selected: rows.length, answerable: primary.eligible, abstention: rows.length - primary.eligible,
      original_questions: population.dataset_question_count }, primary, rows });
  await admitObservation(result, population, populationIdentity, cutoff, false);
  writeChainArtifact(path, result);
  return { path, result };
  });
}
