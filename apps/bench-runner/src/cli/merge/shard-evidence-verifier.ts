import { createHash } from "node:crypto";
import path from "node:path";
import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import {
  resolveBenchDiagnosticsArtifactRoot
} from "../../longmemeval/diagnostics-artifacts.js";
import type { LongMemEvalDiagnosticsSidecar } from "../../longmemeval/diagnostics.js";
import {
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  verifyLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput,
  type LongMemEvalEvidenceManifest
} from "../../longmemeval/evidence-manifest.js";
import {
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema
} from "../../longmemeval/provenance/run.js";
import {
  openContainedArtifact,
  type ContainedArtifactFile
} from "./contained-artifact-path.js";

const verifiedDiagnostics = new WeakSet<object>();
const MAX_BINDING_ARTIFACT_BYTES = 16 * 1024 * 1024;

export async function verifyShardEvidenceBundle(input: {
  readonly shardRoot: string;
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly diagnostics: LongMemEvalDiagnosticsSidecar;
}): Promise<boolean> {
  const entryRoot = path.join(input.shardRoot, "public", input.slug);
  const manifestFile = await openContainedArtifact(
    entryRoot,
    LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME
  );
  if (manifestFile === null) return false;
  let manifest: LongMemEvalEvidenceManifest;
  try {
    manifest = await readJson<LongMemEvalEvidenceManifest>(manifestFile);
  } finally {
    await manifestFile.close();
  }
  assertManifestBinding(manifest, input.slug, input.payload);
  assertCompleteEvidence(manifest);
  const inspected = await Promise.all(manifest.artifacts.map(async (artifact) => {
    const file = await openArtifact(input.shardRoot, entryRoot, artifact);
    try {
      const contents = isBindingRole(artifact.role)
        ? await file.readUtf8(MAX_BINDING_ARTIFACT_BYTES)
        : undefined;
      return {
        evidence: { role: artifact.role, path: artifact.path, identity: await hashFile(file) },
        role: artifact.role,
        contents
      };
    } finally {
      await file.close();
    }
  }));
  const result = verifyLongMemEvalEvidenceManifest(
    manifest,
    inspected.map((artifact) => artifact.evidence)
  );
  if (!result.valid) {
    throw new Error(`merge refused: invalid shard evidence: ${result.errors.join("; ")}`);
  }
  assertArtifactBindings(manifest, inspected, input.payload, input.diagnostics);
  verifiedDiagnostics.add(input.diagnostics);
  return true;
}

function assertCompleteEvidence(manifest: LongMemEvalEvidenceManifest): void {
  const roles = new Set(manifest.artifacts.map((artifact) => artifact.role));
  const required = [
    "kpi", "report", "diagnostics", "full_diagnostics", "cohort_ledger",
    "comparison", "run_provenance"
  ] as const;
  if (manifest.evidence_status !== "complete" ||
    !manifest.run.candidate_pool_complete || manifest.run.provenance_complete !== true ||
    !required.every((role) => roles.has(role)) ||
    required.some((role) => manifest.artifacts.filter((artifact) => artifact.role === role).length !== 1)) {
    throw new Error("merge refused: shard evidence is not a complete shard evidence bundle");
  }
}

export function hasVerifiedShardEvidence(
  diagnostics: LongMemEvalDiagnosticsSidecar
): boolean {
  return verifiedDiagnostics.has(diagnostics);
}

function assertManifestBinding(
  manifest: LongMemEvalEvidenceManifest,
  slug: string,
  payload: KpiPayload
): void {
  if (manifest.schema_version !== 1 || manifest.kind !== "longmemeval_evidence_bundle") {
    throw new Error("merge refused: invalid shard evidence manifest schema");
  }
  const run = manifest.run;
  if (run.slug !== slug || run.bench_name !== "public" || run.split !== payload.split ||
    run.run_at !== payload.run_at || run.alaya_commit !== payload.alaya_commit) {
    throw new Error("merge refused: shard evidence manifest run binding mismatch");
  }
  if (run.dataset_sha256 !== payload.dataset.checksum_sha256) {
    throw new Error("merge refused: shard evidence manifest dataset binding mismatch");
  }
}

interface InspectedArtifact {
  readonly evidence: LongMemEvalEvidenceArtifactInput;
  readonly role: LongMemEvalEvidenceManifest["artifacts"][number]["role"];
  readonly contents: string | undefined;
}

function assertArtifactBindings(
  manifest: LongMemEvalEvidenceManifest,
  artifacts: readonly InspectedArtifact[],
  payload: KpiPayload,
  diagnostics: LongMemEvalDiagnosticsSidecar
): void {
  const cohort = parseRoleJson(artifacts, "cohort_ledger") as {
    question_count?: unknown; question_id_digest?: unknown; rows?: unknown;
  };
  const boundKpi = KpiPayloadSchema.parse(parseRoleJson(artifacts, "kpi"));
  const provenance = LongMemEvalRunProvenanceSchema.parse(
    parseRoleJson(artifacts, "run_provenance")
  );
  if (JSON.stringify(boundKpi) !== JSON.stringify(payload)) {
    throw new Error("merge refused: shard evidence KPI binding mismatch");
  }
  if (cohort.question_count !== payload.evaluated_count || !Array.isArray(cohort.rows)) {
    throw new Error("merge refused: shard evidence cohort binding mismatch");
  }
  const cohortIds = cohort.rows.map((row) =>
    typeof row === "object" && row !== null ? (row as { question_id?: unknown }).question_id : null
  );
  if (!sameValues(cohortIds, payload.kpi.per_scenario.map((row) => row.id))) {
    throw new Error("merge refused: shard evidence cohort question binding mismatch");
  }
  const questionIdDigest = createHash("sha256")
    .update(cohortIds.join("\0"), "utf8")
    .digest("hex");
  if (cohort.question_id_digest !== questionIdDigest ||
    manifest.run.question_id_digest !== questionIdDigest) {
    throw new Error("merge refused: shard evidence cohort digest binding mismatch");
  }
  if (provenance.code.commit_sha7 !== payload.alaya_commit ||
    provenance.execution.evaluated_count !== payload.evaluated_count ||
    !isLongMemEvalRunProvenanceGateEligible(provenance)) {
    throw new Error("merge refused: shard evidence provenance binding mismatch");
  }
  if (manifest.run.selection_manifest_sha256 !==
    (provenance.question_manifest?.file_sha256 ?? null) ||
    (provenance.question_manifest !== null &&
      (provenance.question_manifest.dataset_sha256 !== manifest.run.dataset_sha256 ||
        provenance.question_manifest.selected_id_digest !== questionIdDigest))) {
    throw new Error("merge refused: shard evidence selection binding mismatch");
  }
  if (!diagnostics.questions.every((question) => question.candidate_pool_complete === true)) {
    throw new Error("merge refused: shard evidence candidate pool binding mismatch");
  }
}

function parseRoleJson(
  artifacts: readonly InspectedArtifact[],
  role: InspectedArtifact["role"]
): unknown {
  const contents = artifacts.find((artifact) => artifact.role === role)?.contents;
  if (contents === undefined) throw new Error(`merge refused: missing ${role} binding contents`);
  return JSON.parse(contents) as unknown;
}

function sameValues(actual: readonly unknown[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function isBindingRole(role: InspectedArtifact["role"]): boolean {
  return role === "kpi" || role === "cohort_ledger" || role === "run_provenance";
}

async function openArtifact(
  shardRoot: string,
  entryRoot: string,
  artifact: LongMemEvalEvidenceManifest["artifacts"][number]
): Promise<ContainedArtifactFile> {
  if (artifact.role !== "full_diagnostics") {
    const file = await openContainedArtifact(entryRoot, artifact.path);
    if (file !== null) return file;
  } else {
    const roots = new Set([
      entryRoot,
      resolveBenchDiagnosticsArtifactRoot(shardRoot),
      path.join(shardRoot, ".bench-artifacts")
    ]);
    for (const root of roots) {
      const file = await openContainedArtifact(root, artifact.path);
      if (file !== null) return file;
    }
  }
  throw new Error(`merge refused: missing shard evidence '${artifact.path}'`);
}

async function readJson<T>(file: ContainedArtifactFile): Promise<T> {
  return JSON.parse(await file.readUtf8(MAX_BINDING_ARTIFACT_BYTES)) as T;
}

async function hashFile(
  file: ContainedArtifactFile
): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of file.handle.createReadStream({ autoClose: false, start: 0 })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}
