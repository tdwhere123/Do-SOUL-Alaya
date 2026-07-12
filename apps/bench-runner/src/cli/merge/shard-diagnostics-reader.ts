import path from "node:path";
import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import {
  resolveBenchDiagnosticsArtifactRoot
} from "../../longmemeval/diagnostics-artifacts.js";
import { streamDiagnosticsGzipQuestions } from
  "../../longmemeval/diagnostics/artifact-gzip-reader.js";
import { streamDiagnosticsJsonQuestions } from
  "../../longmemeval/diagnostics/artifact-json-stream.js";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import type { LongMemEvalDiagnosticsSpool } from "../../longmemeval/diagnostics/spool.js";
import { resolveShardPointerPath } from "../merge-shared.js";
import { verifyShardEvidenceBundle } from "./shard-evidence-verifier.js";
import {
  openContainedArtifact,
  type ContainedArtifactFile
} from "./contained-artifact-path.js";

export interface ReadShardPayloadResult {
  readonly payload: KpiPayload;
  readonly slug: string;
  readonly diagnostics: LongMemEvalDiagnosticsSidecar;
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
}

export async function readShardPayload(
  shardRoot: string,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<ReadShardPayloadResult> {
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
  const diagnostics = await readRequiredShardDiagnostics(
    shardRoot,
    pointer.slug,
    diagnosticsSpool
  );
  const questionDiagnostics = diagnostics.questions ?? [];
  validateShardQuestionIdentity(payload, questionDiagnostics, shardRoot);
  await verifyShardEvidenceBundle({
    shardRoot,
    slug: pointer.slug,
    payload,
    diagnostics
  });
  return {
    payload,
    slug: pointer.slug,
    diagnostics,
    questionDiagnostics
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

async function readRequiredShardDiagnostics(
  shardRoot: string,
  slug: string,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LongMemEvalDiagnosticsSidecar> {
  const reference = path.join("public", slug, "longmemeval-diagnostics.json");
  const file = await openContainedArtifact(shardRoot, reference);
  if (file === null) {
    throw new Error(
      `merge refused: missing diagnostics sidecar for shard root=${shardRoot} slug=${slug}`
    );
  }
  return readShardDiagnostics(
    path.join(shardRoot, reference),
    file,
    diagnosticsSpool
  );
}

async function readShardDiagnostics(
  diagnosticsPath: string,
  file: ContainedArtifactFile,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LongMemEvalDiagnosticsSidecar> {
  try {
    if (file.bytes > MAX_INLINE_DIAGNOSTICS_BYTES) {
      throw new Error(
        `inline diagnostics exceeds ${MAX_INLINE_DIAGNOSTICS_BYTES} bytes; migrate to compact external artifact`
      );
    }
    const raw = JSON.parse(await file.readUtf8(MAX_INLINE_DIAGNOSTICS_BYTES)) as
      LongMemEvalDiagnosticsSidecar & CompactDiagnostics;
    const declaredCount = validateCompactQuestionCount(raw);
    const source = await resolveQuestionSource(diagnosticsPath, raw);
    const questions: LongMemEvalQuestionDiagnostic[] = [];
    for await (const question of source) {
      questions.push(await diagnosticsSpool.append(question));
    }
    if (declaredCount !== null && questions.length !== declaredCount) {
      throw new Error(
        `compact diagnostics question_count=${declaredCount} does not match streamed question count=${questions.length}`
      );
    }
    return { ...raw, questions };
  } finally {
    await file.close();
  }
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
  diagnostics: LongMemEvalDiagnosticsSidecar & CompactDiagnostics
): Promise<AsyncIterable<LongMemEvalQuestionDiagnostic>> {
  if (diagnostics.compact_schema_version !== 1 ||
    typeof diagnostics.full_diagnostics_artifact_path !== "string") {
    return questionsFromArray(diagnostics.questions ?? []);
  }
  return streamContainedQuestions(
    diagnosticsPath,
    diagnostics.full_diagnostics_artifact_path
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
  artifactPath: string
): AsyncGenerator<LongMemEvalQuestionDiagnostic> {
  const file = await openFullArtifact(diagnosticsPath, artifactPath);
  try {
    const source = artifactPath.endsWith(".gz")
      ? streamDiagnosticsGzipQuestions(file.handle)
      : streamDiagnosticsJsonQuestions(file.handle);
    yield* source;
  } finally {
    await file.close();
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
