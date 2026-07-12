import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { gunzip } from "node:zlib";
import { readDiagnosticsJsonStream } from "./diagnostics-json-stream-reader.mjs";

const gunzipAsync = promisify(gunzip);

export const STAGE_FIELDS = Object.freeze({
  candidate_pool: "fused_rank",
  rank_after_fusion: "rank_after_fusion",
  feature: "rank_after_feature_rerank",
  lexical: "rank_after_lexical_priority",
  coverage: "rank_after_coverage_selector",
  session: "rank_after_session_coverage",
  synthesis: "rank_after_synthesis_reserve",
  structural: "rank_after_structural_reserve",
  selection_order: "selection_order",
  final_rank: "final_rank"
});

export const STAGE_ORDER = Object.freeze(Object.keys(STAGE_FIELDS));

export async function loadEvidenceBundle(manifestPath) {
  const manifestBuffer = await readFile(manifestPath);
  const manifest = parseJson(manifestBuffer, manifestPath);
  const artifacts = await loadAndVerifyArtifacts(manifest, path.dirname(manifestPath));
  const [diagnostics, cohort] = await Promise.all([
    parseRoleJson(manifest, artifacts, "full_diagnostics"),
    parseRoleJson(manifest, artifacts, "cohort_ledger")
  ]);
  return validateEvidenceBundle({ manifest, diagnostics, cohort });
}

export async function loadReplayContract(manifestPath) {
  return validateReplayContract(await loadEvidenceBundle(manifestPath));
}

export async function consumeReplayContract(manifestPath, options = {}) {
  const manifestBuffer = await readFile(manifestPath);
  const manifest = parseJson(manifestBuffer, manifestPath);
  const artifacts = await loadAndVerifyArtifacts(manifest, path.dirname(manifestPath));
  const cohort = requireObject(
    await parseRoleJson(manifest, artifacts, "cohort_ledger"),
    "cohort"
  );
  const rows = requireArray(cohort.rows, "cohort.rows");
  assertCohortIdentity(rows, manifest, cohort);
  if (options.requireComplete !== false) assertCompleteManifest(manifest);
  let questionCount = 0;
  const diagnostics = await parseRoleJson(manifest, artifacts, "full_diagnostics", {
    collectQuestions: false,
    onQuestion(question, index) {
      const row = rows[index];
      if (row === undefined || question.question_id !== row.question_id) {
        throw new Error("diagnostics/cohort question order mismatch");
      }
      if (options.requireComplete === false) validateEvidenceQuestion(question, row);
      else assertCompleteReplayQuestion(question, row);
      options.onQuestion?.(question, row, index);
      questionCount += 1;
    }
  });
  assertTrailingPartialRows(rows.slice(questionCount));
  if (options.requireComplete !== false && questionCount !== rows.length) {
    throw new Error("complete replay diagnostics/cohort question count mismatch");
  }
  return { manifest, diagnostics, cohort };
}

export function validateEvidenceBundle(input) {
  requireObject(input, "contract");
  const diagnostics = requireObject(input.diagnostics, "diagnostics");
  const cohort = requireObject(input.cohort, "cohort");
  const questions = requireArray(diagnostics.questions, "diagnostics.questions");
  const rows = requireArray(cohort.rows, "cohort.rows");
  assertQuestionIdentity(questions, rows, input.manifest, cohort);
  const rowById = new Map(rows.map((row) => [row.question_id, row]));
  for (const question of questions) {
    validateEvidenceQuestion(question, rowById.get(question.question_id));
  }
  return { manifest: input.manifest, diagnostics, cohort };
}

export function validateReplayContract(input) {
  const contract = validateEvidenceBundle(input);
  assertCompleteManifest(contract.manifest);
  const rowById = new Map(contract.cohort.rows.map((row) => [row.question_id, row]));
  for (const question of contract.diagnostics.questions) {
    assertCompleteReplayQuestion(question, rowById.get(question.question_id));
  }
  return contract;
}

async function loadAndVerifyArtifacts(manifest, manifestDir) {
  assertEvidenceManifest(manifest);
  const artifacts = new Map();
  for (const entry of manifest.artifacts) {
    const artifactPath = path.isAbsolute(entry.path)
      ? entry.path
      : path.resolve(manifestDir, entry.path);
    const binding = await hashArtifact(artifactPath);
    if (binding.bytes !== entry.bytes) {
      throw new Error(`byte length mismatch: ${entry.path}`);
    }
    if (binding.sha256 !== entry.sha256) {
      throw new Error(`sha256 mismatch: ${entry.path}`);
    }
    artifacts.set(entry.path, artifactPath);
  }
  return artifacts;
}

async function hashArtifact(artifactPath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(artifactPath)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function assertEvidenceManifest(manifest) {
  requireObject(manifest, "manifest");
  if (manifest.schema_version !== 1 || manifest.kind !== "longmemeval_evidence_bundle") {
    throw new Error("unsupported LongMemEval evidence manifest");
  }
  requireArray(manifest.artifacts, "manifest.artifacts");
  const paths = new Set();
  for (const entry of manifest.artifacts) {
    requireObject(entry, "manifest artifact");
    if (typeof entry.path !== "string" || entry.path.length === 0 || paths.has(entry.path)) {
      throw new Error(`invalid or duplicate artifact path: ${String(entry.path)}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`invalid artifact binding: ${entry.path}`);
    }
    paths.add(entry.path);
  }
  const { bundle_sha256: stored, ...unsigned } = manifest;
  if (stored !== sha256(JSON.stringify(unsigned))) {
    throw new Error("bundle sha256 mismatch");
  }
  for (const role of ["full_diagnostics", "cohort_ledger"]) {
    if (manifest.artifacts.filter((entry) => entry.role === role).length !== 1) {
      throw new Error(`manifest requires exactly one ${role} artifact`);
    }
  }
}

async function parseRoleJson(manifest, artifacts, role, options = {}) {
  const entry = manifest.artifacts.find((artifact) => artifact.role === role);
  const artifactPath = artifacts.get(entry.path);
  if (role === "full_diagnostics") {
    return readDiagnosticsJsonStream(artifactPath, {
      gzip: entry.path.endsWith(".gz"),
      ...options
    });
  }
  const raw = await readFile(artifactPath);
  if (!entry.path.endsWith(".gz")) return parseJson(raw, entry.path);
  let contents;
  try {
    contents = await gunzipAsync(raw);
  } catch (error) {
    throw new Error(`invalid gzip artifact ${entry.path}: ${error.message}`, { cause: error });
  }
  return parseJson(contents, entry.path);
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${error.message}`);
  }
}

function assertCompleteManifest(manifest) {
  const run = manifest?.run;
  if (manifest?.evidence_status === "partial" || run?.candidate_pool_complete === false) {
    throw new Error("replay requires a complete evidence manifest and candidate pool");
  }
  if (manifest?.kind === "longmemeval_evidence_bundle") {
    if (manifest.evidence_status !== "complete" || run?.candidate_pool_complete !== true) {
      throw new Error("replay requires evidence_status=complete and candidate_pool_complete=true");
    }
  }
}

function assertQuestionIdentity(questions, rows, manifest, cohort) {
  if (questions.length > rows.length || cohort.question_count !== undefined &&
      cohort.question_count !== rows.length) {
    throw new Error("diagnostics/cohort question count mismatch");
  }
  const questionIds = questions.map((question) => requireString(question?.question_id, "question_id"));
  if (new Set(questionIds).size !== questionIds.length) {
    throw new Error("duplicate question ID in replay contract");
  }
  const rowIds = rows.map((row) => requireString(row?.question_id, "cohort question_id"));
  if (questionIds.some((id, index) => id !== rowIds[index])) {
    throw new Error("diagnostics/cohort question order mismatch");
  }
  assertTrailingPartialRows(rows.slice(questions.length));
  assertCohortIdentity(rows, manifest, cohort);
}

function assertCohortIdentity(rows, manifest, cohort) {
  if (cohort.question_count !== undefined && cohort.question_count !== rows.length) {
    throw new Error("diagnostics/cohort question count mismatch");
  }
  const rowIds = rows.map((row) => requireString(row?.question_id, "cohort question_id"));
  if (new Set(rowIds).size !== rowIds.length) {
    throw new Error("duplicate question ID in replay contract");
  }
  const digest = sha256(rowIds.join("\0"));
  if (cohort.question_id_digest !== undefined && cohort.question_id_digest !== digest) {
    throw new Error("cohort question_id_digest mismatch");
  }
  if (manifest?.run?.question_id_digest !== undefined &&
      manifest.run.question_id_digest !== digest) {
    throw new Error("manifest question_id_digest mismatch");
  }
}

function assertTrailingPartialRows(rows) {
  for (const row of rows) {
    requireObject(row, "partial cohort row");
    if (row.candidate_pool_complete !== false ||
        !["missing", "partial"].includes(row.evidence_status)) {
      throw new Error(`cohort-only row must be explicit partial evidence: ${row.question_id}`);
    }
    validateQualityAxes(row.quality_axes, `${row.question_id}.quality_axes`);
  }
}

function validateEvidenceQuestion(question, row) {
  requireObject(question, "diagnostic question");
  requireObject(row, `cohort row for ${question.question_id}`);
  requireArray(question.candidates, `${question.question_id}.candidates`);
  validateQualityAxes(question.quality_axes, `${question.question_id}.quality_axes`);
  validateQualityAxes(row.quality_axes, `${question.question_id}.cohort.quality_axes`);
  validateEmbeddedCohort(question, row);
}

function validateQualityAxes(axes, label) {
  if (axes === undefined) return;
  requireObject(axes, label);
  validateCountRatio(
    axes.answer_session_coverage_at_5,
    "covered_count",
    "total_count",
    `${label}.answer_session_coverage_at_5`
  );
  const coverage = axes.answer_session_coverage_at_5;
  if (coverage.full_coverage !==
      (coverage.total_count > 0 && coverage.covered_count === coverage.total_count)) {
    throw new Error(`${label}.answer_session_coverage_at_5.full_coverage is inconsistent`);
  }
  const literal = requireObject(
    axes.answer_literal_witness_lower_bound_at_5,
    `${label}.answer_literal_witness_lower_bound_at_5`
  );
  if (literal.matched_candidate_count > literal.inspected_candidate_count ||
      literal.matched_candidate_count !== requireArray(literal.witnesses, `${label}.witnesses`).length ||
      literal.witnessed !== (literal.matched_candidate_count > 0)) {
    throw new Error(`${label} matched_candidate_count is inconsistent`);
  }
  const timestamps = axes.source_timestamp_availability_at_5;
  validateCountRatio(timestamps, "available_count", "candidate_count",
    `${label}.source_timestamp_availability_at_5`);
  if (timestamps.all_available !==
      (timestamps.candidate_count > 0 && timestamps.available_count === timestamps.candidate_count)) {
    throw new Error(`${label}.source_timestamp_availability_at_5.all_available is inconsistent`);
  }
  if (axes.abstention?.applicable !== (axes.abstention?.status !== "not_applicable")) {
    throw new Error(`${label}.abstention applicability is inconsistent`);
  }
}

function validateCountRatio(value, numeratorField, denominatorField, label) {
  requireObject(value, label);
  const numerator = value[numeratorField];
  const denominator = value[denominatorField];
  if (!Number.isSafeInteger(numerator) || numerator < 0 ||
      !Number.isSafeInteger(denominator) || denominator < 0 || numerator > denominator) {
    throw new Error(`${label} ${numeratorField} must be <= ${denominatorField}`);
  }
  const expected = denominator === 0 ? null : numerator / denominator;
  if (value.ratio !== expected) throw new Error(`${label}.ratio is inconsistent`);
}

export function assertCompleteReplayQuestion(question, row) {
  validateEvidenceQuestion(question, row);
  if (question.candidate_pool_complete !== true || row.candidate_pool_complete !== true) {
    throw new Error(`candidate_pool_complete=true required for question ${question.question_id}`);
  }
  for (const [index, candidate] of question.candidates.entries()) {
    validateCandidate(candidate, `${question.question_id}.candidates[${index}]`);
  }
  return question;
}

function validateCandidate(candidate, label) {
  requireObject(candidate, label);
  requireString(candidate.object_id, `${label}.object_id`);
  for (const field of Object.values(STAGE_FIELDS)) {
    if (!Object.hasOwn(candidate, field)) {
      throw new Error(`missing required rank field ${field} at ${label}`);
    }
    const rank = candidate[field];
    if (rank !== null && (!Number.isSafeInteger(rank) || rank <= 0)) {
      throw new Error(`invalid explicit rank field ${field} at ${label}`);
    }
  }
}

function validateEmbeddedCohort(question, row) {
  if (question.cohort_ledger === undefined) {
    throw new Error(`missing embedded cohort_ledger for ${question.question_id}`);
  }
  const { question_id: _questionId, ...expected } = row;
  if (!isDeepStrictEqual(question.cohort_ledger, expected)) {
    throw new Error(`embedded cohort_ledger drift for ${question.question_id}`);
  }
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`missing required array field: ${field}`);
  return value;
}

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`missing required object field: ${field}`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required string field: ${field}`);
  }
  return value;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
