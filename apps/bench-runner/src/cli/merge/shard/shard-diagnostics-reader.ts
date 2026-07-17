import { createHash } from "node:crypto";
import path from "node:path";
import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from
  "../../../longmemeval/archive/archive-evidence.js";
import {
  resolveBenchDiagnosticsArtifactRoot
} from "../../../longmemeval/diagnostics/artifacts/diagnostics-artifacts.js";
import { streamDiagnosticsGzipQuestions } from
  "../../../longmemeval/diagnostics/artifacts/artifact-gzip-reader.js";
import { streamDiagnosticsJsonQuestions } from
  "../../../longmemeval/diagnostics/artifacts/artifact-json-stream.js";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalQuestionDiagnostic
} from "../../../longmemeval/diagnostics.js";
import type { LongMemEvalDiagnosticsSpool } from "../../../longmemeval/diagnostics/spool.js";
import { resolveShardPointerPath } from "../../merge-shared.js";
import {
  bindVerifiedShardDiagnostics,
  verifyShardEvidenceBundle,
  type VerifiedArtifactIdentity,
  type VerifiedShardEvidence
} from "./shard-evidence-verifier.js";
import {
  openContainedArtifact,
  type ContainedArtifactFile
} from "../contained-artifact-path.js";
import type { LoadedGlobalExtractionAuthority } from
  "../../../longmemeval/provenance/contract/extraction-authority-reference.js";

export interface ReadShardPayloadResult {
  readonly payload: KpiPayload;
  readonly slug: string;
  readonly diagnostics: LongMemEvalDiagnosticsSidecar;
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly verifiedEvidence: VerifiedShardEvidence | null;
}

export interface ShardPayloadPlan {
  readonly root: string;
  readonly payload: KpiPayload;
  readonly slug: string;
  readonly diagnostics: ShardDiagnosticsPlan;
  readonly verifiedEvidence: VerifiedShardEvidence | null;
}

export async function readShardPayload(
  shardRoot: string,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<ReadShardPayloadResult> {
  return materializeShardPayload(
    await readShardPayloadPlan(shardRoot),
    diagnosticsSpool
  );
}

export async function readShardPayloadPlan(
  shardRoot: string,
  options: {
    readonly globalExtractionAuthority?: LoadedGlobalExtractionAuthority | null;
  } = {}
): Promise<ShardPayloadPlan> {
  const pointerPath = await resolveShardPointerPath(shardRoot);
  const pointer = await readContainedJson<{ slug?: string }>(
    shardRoot,
    path.relative(shardRoot, pointerPath)
  );
  if (typeof pointer.slug !== "string" || !CANONICAL_SLUG.test(pointer.slug)) {
    throw new Error(
      `shard ${shardRoot} ${path.basename(pointerPath)} missing slug`
    );
  }
  const payload = await readShardKpi(shardRoot, pointer.slug);
  const verifiedEvidence = await verifyShardEvidenceBundle({
    shardRoot,
    slug: pointer.slug,
    payload,
    globalExtractionAuthority: options.globalExtractionAuthority
  });
  const diagnostics = await readRequiredShardDiagnosticsPlan(
    shardRoot,
    pointer.slug,
    verifiedEvidence
  );
  return { root: shardRoot, payload, slug: pointer.slug, diagnostics, verifiedEvidence };
}

export async function materializeShardPayload(
  plan: ShardPayloadPlan,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<ReadShardPayloadResult> {
  const diagnostics = await materializeShardDiagnostics(plan.diagnostics, diagnosticsSpool);
  const questionDiagnostics = diagnostics.questions ?? [];
  validateShardQuestionIdentity(plan.payload, questionDiagnostics, plan.root);
  if (plan.verifiedEvidence !== null) {
    bindVerifiedShardDiagnostics(plan.verifiedEvidence, diagnostics);
  }
  return {
    payload: plan.payload,
    slug: plan.slug,
    diagnostics,
    questionDiagnostics,
    verifiedEvidence: plan.verifiedEvidence
  };
}

function validateShardQuestionIdentity(
  payload: KpiPayload,
  diagnostics: readonly LongMemEvalQuestionDiagnostic[],
  shardRoot: string
): void {
  const kpiIds = payload.kpi.per_scenario.map((row) => row.id);
  const diagnosticIds = diagnostics.map((row) => row.question_id);
  if (kpiIds.length !== diagnosticIds.length) {
    throw new Error(
      `merge refused: shard question identity count mismatch root=${shardRoot}: ` +
      `kpi=${kpiIds.length} diagnostics=${diagnosticIds.length}`
    );
  }
  for (let index = 0; index < kpiIds.length; index += 1) {
    if (kpiIds[index] === diagnosticIds[index]) continue;
    throw new Error(
      `merge refused: shard question identity mismatch at index=${index}: ` +
      `kpi='${kpiIds[index]}' diagnostics='${diagnosticIds[index]}' root=${shardRoot}`
    );
  }
}

export function isCurrentStreamedDiagnostics(
  diagnostics: LongMemEvalDiagnosticsSidecar
): boolean {
  const compact = diagnostics as CompactDiagnostics;
  return compact.compact_schema_version === 1 &&
    typeof compact.full_diagnostics_artifact_path === "string" &&
    compact.full_diagnostics_artifact_path.endsWith(".gz");
}

async function readShardKpi(shardRoot: string, slug: string): Promise<KpiPayload> {
  const raw = await readContainedJson<unknown>(
    shardRoot,
    path.join("public", slug, "kpi.json")
  );
  return KpiPayloadSchema.parse(raw);
}

async function readRequiredShardDiagnosticsPlan(
  shardRoot: string,
  slug: string,
  verifiedEvidence: VerifiedShardEvidence | null
): Promise<ShardDiagnosticsPlan> {
  const reference = path.join("public", slug, LONGMEMEVAL_DIAGNOSTICS_FILENAME);
  const file = await openContainedArtifact(shardRoot, reference);
  if (file === null) {
    throw new Error(
      `merge refused: missing diagnostics sidecar for shard root=${shardRoot} slug=${slug}`
    );
  }
  return readShardDiagnosticsPlan(
    path.join(shardRoot, reference),
    file,
    verifiedEvidence?.diagnosticsArtifact ?? null,
    verifiedEvidence?.fullDiagnosticsArtifact ?? null
  );
}

interface ShardDiagnosticsPlan {
  readonly diagnosticsPath: string;
  readonly raw: LongMemEvalDiagnosticsSidecar & CompactDiagnostics;
  readonly declaredCount: number | null;
  readonly fullDiagnosticsArtifact: VerifiedArtifactIdentity | null;
}

async function readShardDiagnosticsPlan(
  diagnosticsPath: string,
  file: ContainedArtifactFile,
  diagnosticsArtifact: VerifiedArtifactIdentity | null,
  fullDiagnosticsArtifact: VerifiedArtifactIdentity | null
): Promise<ShardDiagnosticsPlan> {
  try {
    if (file.bytes > MAX_INLINE_DIAGNOSTICS_BYTES) {
      throw new Error(
        `inline diagnostics exceeds ${MAX_INLINE_DIAGNOSTICS_BYTES} bytes; migrate to compact external artifact`
      );
    }
    const contents = await file.readUtf8(MAX_INLINE_DIAGNOSTICS_BYTES);
    assertCompactArtifactIdentity(contents, diagnosticsArtifact);
    const raw = JSON.parse(contents) as
      LongMemEvalDiagnosticsSidecar & CompactDiagnostics;
    assertFullArtifactReference(raw, fullDiagnosticsArtifact);
    return {
      diagnosticsPath,
      raw,
      declaredCount: validateCompactQuestionCount(raw),
      fullDiagnosticsArtifact
    };
  } finally {
    await file.close();
  }
}

async function materializeShardDiagnostics(
  plan: ShardDiagnosticsPlan,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LongMemEvalDiagnosticsSidecar> {
  const source = await resolveQuestionSource(
    plan.diagnosticsPath,
    plan.raw,
    plan.fullDiagnosticsArtifact
  );
  const questions: LongMemEvalQuestionDiagnostic[] = [];
  for await (const question of source) {
    questions.push(await diagnosticsSpool.append(question));
  }
  if (plan.declaredCount !== null && questions.length !== plan.declaredCount) {
    throw new Error(
      `compact diagnostics question_count=${plan.declaredCount} does not match streamed question count=${questions.length}`
    );
  }
  return { ...plan.raw, questions };
}

interface CompactDiagnostics {
  readonly compact_schema_version?: number;
  readonly question_count?: unknown;
  readonly full_diagnostics_artifact_path?: string;
}

function validateCompactQuestionCount(diagnostics: CompactDiagnostics): number | null {
  if (diagnostics.compact_schema_version !== 1) return null;
  if (typeof diagnostics.question_count !== "number" ||
    !Number.isInteger(diagnostics.question_count) || diagnostics.question_count < 0) {
    throw new Error(
      "invalid compact diagnostics question_count: expected non-negative integer"
    );
  }
  return diagnostics.question_count;
}

async function resolveQuestionSource(
  diagnosticsPath: string,
  diagnostics: LongMemEvalDiagnosticsSidecar & CompactDiagnostics,
  fullDiagnosticsArtifact: VerifiedArtifactIdentity | null
): Promise<AsyncIterable<LongMemEvalQuestionDiagnostic>> {
  if (diagnostics.compact_schema_version !== 1 ||
    typeof diagnostics.full_diagnostics_artifact_path !== "string") {
    return questionsFromArray(diagnostics.questions ?? []);
  }
  return streamContainedQuestions(
    diagnosticsPath,
    diagnostics.full_diagnostics_artifact_path,
    fullDiagnosticsArtifact
  );
}

async function openFullArtifact(
  diagnosticsPath: string,
  artifactPath: string
): Promise<ContainedArtifactFile> {
  const historyRoot = path.dirname(path.dirname(path.dirname(diagnosticsPath)));
  const roots = [
    path.dirname(diagnosticsPath),
    resolveBenchDiagnosticsArtifactRoot(historyRoot),
    path.join(historyRoot, ".bench-artifacts")
  ];
  for (const root of new Set(roots)) {
    const file = await openContainedArtifact(root, artifactPath);
    if (file !== null) return file;
  }
  throw new Error(`merge refused: diagnostics artifact not found '${artifactPath}'`);
}

async function* streamContainedQuestions(
  diagnosticsPath: string,
  artifactPath: string,
  expected: VerifiedArtifactIdentity | null
): AsyncGenerator<LongMemEvalQuestionDiagnostic> {
  if (expected !== null && artifactPath !== expected.path) {
    throw new Error("merge refused: full diagnostics artifact identity mismatch");
  }
  const file = await openFullArtifact(diagnosticsPath, artifactPath);
  const hash = createHash("sha256");
  let bytes = 0;
  const observeArtifactChunk = (chunk: Uint8Array): void => {
    hash.update(chunk);
    bytes += chunk.byteLength;
  };
  try {
    const source = artifactPath.endsWith(".gz")
      ? streamDiagnosticsGzipQuestions(file.handle, { observeArtifactChunk })
      : streamDiagnosticsJsonQuestions(file.handle, { observeArtifactChunk });
    yield* source;
    if (expected !== null &&
        (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)) {
      throw new Error("merge refused: full diagnostics artifact identity mismatch");
    }
  } finally {
    await file.close();
  }
}

function assertCompactArtifactIdentity(
  contents: string,
  expected: VerifiedArtifactIdentity | null
): void {
  if (expected === null) return;
  const bytes = Buffer.from(contents, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected.path !== LONGMEMEVAL_DIAGNOSTICS_FILENAME ||
      expected.bytes !== bytes.byteLength || expected.sha256 !== sha256) {
    throw new Error("merge refused: compact diagnostics artifact identity mismatch");
  }
}

function assertFullArtifactReference(
  diagnostics: CompactDiagnostics,
  expected: VerifiedArtifactIdentity | null
): void {
  if (expected === null || diagnostics.compact_schema_version !== 1) return;
  if (diagnostics.full_diagnostics_artifact_path !== expected.path) {
    throw new Error("merge refused: full diagnostics artifact identity mismatch");
  }
}

async function readContainedJson<T>(root: string, reference: string): Promise<T> {
  const file = await openContainedArtifact(root, reference);
  if (file === null) {
    const error = new Error(`missing contained artifact '${reference}'`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  try {
    return JSON.parse(await file.readUtf8(MAX_INLINE_DIAGNOSTICS_BYTES)) as T;
  } finally {
    await file.close();
  }
}

const MAX_INLINE_DIAGNOSTICS_BYTES = 64 * 1024 * 1024;
const CANONICAL_SLUG = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}(?:-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$/u;

async function* questionsFromArray(
  questions: readonly LongMemEvalQuestionDiagnostic[]
): AsyncGenerator<LongMemEvalQuestionDiagnostic> {
  yield* questions;
}
