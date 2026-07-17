import { createHash } from "node:crypto";
import path from "node:path";
import {
  KpiPayloadSchema,
  computeLongMemEvalCohortAssignmentDigest,
  computeLongMemEvalQuestionIdDigest,
  type KpiPayload,
  type LongMemEvalSelectionAssignment,
  type LongMemEvalSelectionContractIdentity
} from "@do-soul/alaya-eval";
import {
  resolveBenchDiagnosticsArtifactRoot
} from "../../../longmemeval/diagnostics/artifacts/diagnostics-artifacts.js";
import type { LongMemEvalDiagnosticsSidecar } from "../../../longmemeval/diagnostics.js";
import {
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  verifyLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput,
  type LongMemEvalEvidenceManifest
} from "../../../longmemeval/provenance/evidence-manifest.js";
import {
  type LongMemEvalRunProvenance
} from "../../../longmemeval/provenance/run.js";
import type { LoadedGlobalExtractionAuthority } from
  "../../../longmemeval/provenance/contract/extraction-authority-reference.js";
import {
  verifyShardRunProvenance,
  type ShardArchivedRunProvenance
} from "./shard-provenance-verifier.js";
import {
  openContainedArtifact,
  type ContainedArtifactFile
} from "../contained-artifact-path.js";
const verifiedDiagnostics = new WeakSet<object>();
const verifiedShardEvidence = new WeakSet<object>();
const MAX_BINDING_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_RUN_PROVENANCE_BYTES = 64 * 1024 * 1024;

export interface VerifiedShardEvidence {
  readonly execution: LongMemEvalRunProvenance["execution"];
  readonly selectionContract: LongMemEvalSelectionContractIdentity;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
  readonly diagnosticsArtifact: VerifiedArtifactIdentity;
  readonly fullDiagnosticsArtifact: VerifiedArtifactIdentity;
  readonly runProvenance: {
    readonly contents: string;
    readonly parsed: ShardArchivedRunProvenance;
    readonly gateEligible: true;
  };
  readonly extractionAuthorityReference: {
    readonly contents: string;
  } | null;
}

export interface VerifiedArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export async function verifyShardEvidenceBundle(input: {
  readonly shardRoot: string;
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly globalExtractionAuthority?: LoadedGlobalExtractionAuthority | null;
}, hooks: {
  readonly afterBindingArtifactSnapshot?: (path: string) => void | Promise<void>;
} = {}): Promise<VerifiedShardEvidence | null> {
  const entryRoot = path.join(input.shardRoot, "public", input.slug);
  const manifestFile = await openContainedArtifact(
    entryRoot,
    LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME
  );
  if (manifestFile === null) return null;
  let manifest: LongMemEvalEvidenceManifest;
  try {
    manifest = await readJson<LongMemEvalEvidenceManifest>(manifestFile);
  } finally {
    await manifestFile.close();
  }
  assertManifestBinding(manifest, input.slug, input.payload);
  assertCompleteEvidence(manifest);
  const inspected = await inspectEvidenceArtifacts(
    input.shardRoot,
    entryRoot,
    manifest,
    hooks
  );
  const result = verifyLongMemEvalEvidenceManifest(
    manifest,
    inspected.map((artifact) => artifact.evidence)
  );
  if (!result.valid) {
    throw new Error(`merge refused: invalid shard evidence: ${result.errors.join("; ")}`);
  }
  const verified = assertArtifactBindings(
    manifest,
    inspected,
    input.payload,
    input.globalExtractionAuthority ?? null
  );
  verifiedShardEvidence.add(verified);
  return verified;
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

export function bindVerifiedShardDiagnostics(
  evidence: VerifiedShardEvidence,
  diagnostics: LongMemEvalDiagnosticsSidecar
): void {
  if (!verifiedShardEvidence.has(evidence) ||
      !diagnostics.questions.every((question) =>
        question.candidate_pool_complete === true
      )) {
    throw new Error("merge refused: shard evidence candidate pool binding mismatch");
  }
  verifiedDiagnostics.add(diagnostics);
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

async function inspectEvidenceArtifacts(
  shardRoot: string,
  entryRoot: string,
  manifest: LongMemEvalEvidenceManifest,
  hooks: {
    readonly afterBindingArtifactSnapshot?: (path: string) => void | Promise<void>;
  }
): Promise<readonly InspectedArtifact[]> {
  return Promise.all(manifest.artifacts.map(async (artifact) => {
    const file = await openArtifact(shardRoot, entryRoot, artifact);
    try {
      if (isBindingRole(artifact.role)) {
        const bytes = await file.readBytes(bindingArtifactByteLimit(artifact.role));
        await hooks.afterBindingArtifactSnapshot?.(artifact.path);
        return {
          evidence: { role: artifact.role, path: artifact.path, contents: bytes },
          role: artifact.role,
          contents: decodeBindingArtifact(bytes, artifact.path)
        };
      }
      return {
        evidence: { role: artifact.role, path: artifact.path, identity: await hashFile(file) },
        role: artifact.role,
        contents: undefined
      };
    } finally {
      await file.close();
    }
  }));
}

function decodeBindingArtifact(bytes: Uint8Array, artifactPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`merge refused: invalid UTF-8 in '${artifactPath}': ${message}`);
  }
}

function assertArtifactBindings(
  manifest: LongMemEvalEvidenceManifest,
  artifacts: readonly InspectedArtifact[],
  payload: KpiPayload,
  globalExtractionAuthority: LoadedGlobalExtractionAuthority | null
): VerifiedShardEvidence {
  const { cohort, boundKpi, provenance, provenanceContents } =
    parseBindingArtifacts(artifacts, globalExtractionAuthority);
  const questionIdDigest = assertKpiCohortBinding(
    manifest,
    cohort,
    boundKpi,
    payload
  );
  assertProvenanceBinding(provenance.hydrated, manifest, payload);
  const selection = assertSelectionContractBinding(
    provenance.hydrated, manifest, cohort, cohort.rows, questionIdDigest
  );
  if (JSON.stringify(boundKpi.selection_contract) !==
      JSON.stringify(selection.selectionContract)) {
    throw new Error("merge refused: shard KPI selection contract binding mismatch");
  }
  return {
    execution: provenance.hydrated.execution,
    ...selection,
    diagnosticsArtifact: verifiedArtifactIdentity(manifest, "diagnostics"),
    fullDiagnosticsArtifact: verifiedArtifactIdentity(manifest, "full_diagnostics"),
    runProvenance: {
      contents: provenanceContents,
      parsed: provenance.archived,
      gateEligible: true
    },
    extractionAuthorityReference: provenance.referenceContents === null
      ? null
      : { contents: provenance.referenceContents }
  };
}

function assertKpiCohortBinding(
  manifest: LongMemEvalEvidenceManifest,
  cohort: ReturnType<typeof parseBindingArtifacts>["cohort"],
  boundKpi: KpiPayload,
  payload: KpiPayload
): string {
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
  const questionIdDigest = computeLongMemEvalQuestionIdDigest(
    payload.kpi.per_scenario.map((row) => row.id)
  );
  if (cohort.question_id_digest !== questionIdDigest ||
    manifest.run.question_id_digest !== questionIdDigest) {
    throw new Error("merge refused: shard evidence cohort digest binding mismatch");
  }
  return questionIdDigest;
}

function assertProvenanceBinding(
  provenance: LongMemEvalRunProvenance,
  manifest: LongMemEvalEvidenceManifest,
  payload: KpiPayload
): void {
  if (provenance.code.commit_sha7 !== payload.alaya_commit ||
    provenance.dataset_sha256 !== manifest.run.dataset_sha256 ||
    provenance.execution.evaluated_count !== payload.evaluated_count) {
    throw new Error("merge refused: shard evidence provenance binding mismatch");
  }
  assertSourceManifestBinding(provenance, manifest);
}

function parseBindingArtifacts(
  artifacts: readonly InspectedArtifact[],
  globalExtractionAuthority: LoadedGlobalExtractionAuthority | null
) {
  const cohort = parseRoleJson(artifacts, "cohort_ledger") as {
    question_count?: unknown;
    question_id_digest?: unknown;
    rows?: unknown;
    selection_contract?: unknown;
  };
  const provenanceContents = roleContents(artifacts, "run_provenance");
  const referenceContents = optionalRoleContents(
    artifacts,
    "extraction_authority_ref"
  );
  return {
    cohort,
    boundKpi: KpiPayloadSchema.parse(parseRoleJson(artifacts, "kpi")),
    provenanceContents,
    provenance: verifyShardRunProvenance({
      provenanceContents,
      referenceContents,
      globalAuthority: globalExtractionAuthority
    })
  };
}

function assertSourceManifestBinding(
  provenance: LongMemEvalRunProvenance,
  manifest: LongMemEvalEvidenceManifest
): void {
  if (manifest.run.selection_manifest_sha256 !==
    (provenance.question_manifest?.file_sha256 ?? null) ||
    (provenance.question_manifest !== null &&
      provenance.question_manifest.dataset_sha256 !== manifest.run.dataset_sha256)) {
    throw new Error("merge refused: shard evidence selection binding mismatch");
  }
}

function assertSelectionContractBinding(
  provenance: LongMemEvalRunProvenance,
  manifest: LongMemEvalEvidenceManifest,
  cohort: { readonly question_count?: unknown; readonly selection_contract?: unknown },
  rows: unknown,
  questionIdDigest: string
): Pick<VerifiedShardEvidence, "selectionContract" | "assignments"> {
  const selection = provenance.selection;
  if (selection === undefined || !Array.isArray(rows) ||
      selection.selected_id_digest !== questionIdDigest ||
      selection.selected_count !== cohort.question_count ||
      JSON.stringify(selection) !== JSON.stringify(cohort.selection_contract) ||
      JSON.stringify(selection) !== JSON.stringify(manifest.run.selection_contract)) {
    throw new Error("merge refused: shard evidence immutable selection binding mismatch");
  }
  const assignments = rows.map(readCohortAssignment);
  const counts = {
    answerable: assignments.filter((row) => row.dataset_cohort === "answerable").length,
    abstention: assignments.filter((row) => row.dataset_cohort === "abstention").length
  };
  if (JSON.stringify(counts) !== JSON.stringify(selection.expected_cohort_counts) ||
      computeLongMemEvalCohortAssignmentDigest(assignments) !==
        selection.cohort_assignment_digest) {
    throw new Error("merge refused: shard evidence cohort assignment binding mismatch");
  }
  return { selectionContract: selection, assignments };
}

function readCohortAssignment(row: unknown): LongMemEvalSelectionAssignment {
  if (typeof row !== "object" || row === null) {
    throw new Error("merge refused: shard evidence cohort row is invalid");
  }
  const value = row as { readonly question_id?: unknown; readonly dataset_cohort?: unknown };
  if (typeof value.question_id !== "string" ||
      (value.dataset_cohort !== "answerable" && value.dataset_cohort !== "abstention")) {
    throw new Error("merge refused: shard evidence cohort assignment is not immutable");
  }
  return { question_id: value.question_id, dataset_cohort: value.dataset_cohort };
}

function parseRoleJson(
  artifacts: readonly InspectedArtifact[],
  role: InspectedArtifact["role"]
): unknown {
  return JSON.parse(roleContents(artifacts, role)) as unknown;
}

function roleContents(
  artifacts: readonly InspectedArtifact[],
  role: InspectedArtifact["role"]
): string {
  const contents = artifacts.find((artifact) => artifact.role === role)?.contents;
  if (contents === undefined) throw new Error(`merge refused: missing ${role} binding contents`);
  return contents;
}

function optionalRoleContents(
  artifacts: readonly InspectedArtifact[],
  role: InspectedArtifact["role"]
): string | null {
  const contents = artifacts.find((artifact) => artifact.role === role)?.contents;
  return contents ?? null;
}

function verifiedArtifactIdentity(
  manifest: LongMemEvalEvidenceManifest,
  role: LongMemEvalEvidenceManifest["artifacts"][number]["role"]
): VerifiedArtifactIdentity {
  const artifact = manifest.artifacts.find((candidate) => candidate.role === role);
  if (artifact === undefined) {
    throw new Error(`merge refused: missing ${role} artifact identity`);
  }
  return { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes };
}

function sameValues(actual: readonly unknown[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function isBindingRole(role: InspectedArtifact["role"]): boolean {
  return role === "kpi" || role === "cohort_ledger" ||
    role === "run_provenance" || role === "extraction_authority_ref";
}

function bindingArtifactByteLimit(role: InspectedArtifact["role"]): number {
  return role === "run_provenance"
    ? MAX_RUN_PROVENANCE_BYTES
    : MAX_BINDING_ARTIFACT_BYTES;
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
