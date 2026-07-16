import { createHash } from "node:crypto";
import { z } from "zod";
import {
  KpiPayloadSchema,
  type KpiPayload
} from "../schema/kpi-schema.js";
import {
  computeLongMemEvalCohortAssignmentDigest,
  computeLongMemEvalQuestionIdDigest,
  createLongMemEvalSelectionContractIdentity,
  LongMemEvalSelectionContractIdentitySchema,
  type LongMemEvalSelectionAssignment,
  type LongMemEvalSelectionContractIdentity
} from "../schema/longmemeval-selection-contract.js";
import {
  assertLongMemEvalProvenanceBinding,
  RunProvenanceBindingSchema
} from "./longmemeval-provenance-binding.js";
import { canonicalJson } from "./canonical-json.js";
import { createLongMemEvalArtifactReader } from
  "./longmemeval-artifact-reader.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ArtifactSchema = z.object({
  role: z.string().min(1),
  path: z.string().min(1),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative()
}).strict();
const ManifestSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval_evidence_bundle"),
  profile: z.enum(["full_run", "recall_eval"]).optional(),
  run: z.object({
    slug: z.string().min(1),
    bench_name: z.string().min(1),
    split: z.string().min(1),
    run_at: z.string().min(1),
    alaya_commit: z.string().min(1),
    dataset_sha256: Sha256Schema,
    selection_manifest_sha256: Sha256Schema.nullable(),
    question_id_digest: Sha256Schema,
    selection_contract: LongMemEvalSelectionContractIdentitySchema,
    candidate_pool_complete: z.literal(true),
    provenance_complete: z.literal(true)
  }).strict(),
  evidence_status: z.literal("complete"),
  artifacts: z.array(ArtifactSchema),
  bundle_sha256: Sha256Schema
}).strict();

type EvidenceManifest = z.infer<typeof ManifestSchema>;

export const LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME =
  "longmemeval-evidence-manifest.json";

interface LongMemEvalEvidenceArtifactBase {
  readonly role: string;
  readonly path: string;
}

export type LongMemEvalEvidenceArtifact = LongMemEvalEvidenceArtifactBase & (
  | {
      readonly contents: string | Uint8Array;
      readonly identity?: never;
    }
  | {
      readonly contents?: never;
      readonly identity: { readonly sha256: string; readonly bytes: number };
    }
);

declare const verifiedEvidenceBrand: unique symbol;

export interface VerifiedLongMemEvalEvidenceContext {
  readonly [verifiedEvidenceBrand]: true;
  readonly datasetSha256: string;
  readonly selection: LongMemEvalSelectionContractIdentity;
}

const verifiedContexts = new WeakMap<object, string>();
const REQUIRED_FULL_RUN_ROLES = [
  "kpi",
  "report",
  "diagnostics",
  "full_diagnostics",
  "cohort_ledger",
  "comparison",
  "run_provenance"
] as const;
const REQUIRED_RECALL_EVAL_ROLES = [
  "kpi",
  "report",
  "rank_identity",
  "run_provenance",
  "recall_eval_diagnostics"
] as const;
const OPTIONAL_RECALL_EVAL_ROLES = ["findings"] as const;

declare const releaseEvidenceAuthorityBrand: unique symbol;

export interface LongMemEvalReleaseEvidenceAuthority {
  readonly [releaseEvidenceAuthorityBrand]: true;
}

export interface LongMemEvalFullDiagnosticsValidationInput {
  readonly contents: Uint8Array;
  readonly payload: KpiPayload;
}

export type LongMemEvalFullDiagnosticsValidator = (
  input: LongMemEvalFullDiagnosticsValidationInput
) => void | Promise<void>;

const releaseEvidenceAuthorities = new WeakMap<object, ActualSelection>();

export function createLongMemEvalReleaseEvidenceAuthority(input: {
  readonly datasetSha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}): LongMemEvalReleaseEvidenceAuthority {
  const actualSelection = {
    dataset_sha256: input.datasetSha256,
    assignments: Object.freeze(input.assignments.map((row) => Object.freeze({ ...row })))
  };
  selectionIdentity(actualSelection);
  const authority = Object.freeze({}) as LongMemEvalReleaseEvidenceAuthority;
  releaseEvidenceAuthorities.set(authority, actualSelection);
  return authority;
}

export async function loadLongMemEvalReleaseEvidenceFromAuthority(input: {
  readonly entryRoot: string;
  readonly payload: KpiPayload;
  readonly authority: LongMemEvalReleaseEvidenceAuthority;
  readonly validateFullDiagnostics: LongMemEvalFullDiagnosticsValidator;
}): Promise<VerifiedLongMemEvalEvidenceContext> {
  const payload = KpiPayloadSchema.parse(input.payload);
  const reader = createLongMemEvalArtifactReader<EvidenceReadRole>({
    root: input.entryRoot,
    maxBytesByRole: EVIDENCE_ARTIFACT_LIMITS
  });
  const manifestRaw = await reader.readJson(
    "manifest",
    LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME
  );
  const manifest = ManifestSchema.parse(manifestRaw);
  const artifacts = await Promise.all(manifest.artifacts.map(async (artifact) => {
    const role = evidenceReadRole(artifact.role);
    return {
      role: artifact.role,
      path: artifact.path,
      contents: await reader.readBytes(role, artifact.path)
    };
  }));
  const actualSelection = releaseEvidenceAuthorities.get(input.authority);
  if (actualSelection === undefined) {
    throw new Error("LongMemEval release evidence authority is not verified");
  }
  assertLongMemEvalReleaseEvidence({
    payload,
    manifest,
    manifestRaw,
    artifacts,
    actualSelection
  });
  await validateFullDiagnosticsArtifact(
    artifacts,
    payload,
    input.validateFullDiagnostics
  );
  const context = Object.freeze({
    datasetSha256: actualSelection.dataset_sha256,
    selection: selectionIdentity(actualSelection)
  }) as VerifiedLongMemEvalEvidenceContext;
  verifiedContexts.set(context, payloadIdentity(payload));
  return context;
}

async function validateFullDiagnosticsArtifact(
  artifacts: readonly LongMemEvalEvidenceArtifact[],
  payload: KpiPayload,
  validator: LongMemEvalFullDiagnosticsValidator | undefined
): Promise<void> {
  if (typeof validator !== "function") {
    throw new Error("LongMemEval full diagnostics validator is required");
  }
  const artifact = artifacts.find((item) => item.role === "full_diagnostics");
  if (artifact?.contents === undefined || typeof artifact.contents === "string") {
    throw new Error("missing full_diagnostics artifact bytes");
  }
  await validator({
    contents: artifact.contents,
    payload
  });
}

function assertLongMemEvalReleaseEvidence(input: {
  readonly payload: KpiPayload;
  readonly manifest: EvidenceManifest;
  readonly manifestRaw: unknown;
  readonly artifacts: readonly LongMemEvalEvidenceArtifact[];
  readonly actualSelection: ActualSelection;
}): void {
  const { manifest, artifacts } = input;
  assertEvidenceArtifactIntegrity(manifest, artifacts, input.manifestRaw);
  assertManifestPayloadIdentity(manifest, input.payload);
  const binding = readBindingArtifacts(artifacts);
  assertBoundKpi(input.payload, binding.kpi);
  assertCohortBinding(input.payload, manifest, binding.cohort);
  assertLongMemEvalProvenanceBinding({
    payload: input.payload,
    manifest,
    provenance: binding.provenance,
    cohort: binding.cohort,
    artifacts
  });
  assertExternalIdentity(input.payload, artifacts, manifest, input.actualSelection);
}

export function verifiedLongMemEvalEvidenceMatches(
  payload: KpiPayload,
  context: VerifiedLongMemEvalEvidenceContext | null | undefined
): boolean {
  return context !== null && context !== undefined &&
    verifiedContexts.get(context) === payloadIdentity(payload);
}

export function verifyLongMemEvalEvidenceArtifactIntegrity(
  manifest: unknown,
  artifacts: readonly LongMemEvalEvidenceArtifact[]
): { readonly valid: boolean; readonly errors: readonly string[] } {
  try {
    assertEvidenceArtifactIntegrity(ManifestSchema.parse(manifest), artifacts, manifest);
    return { valid: true, errors: [] };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function assertEvidenceArtifactIntegrity(
  manifest: EvidenceManifest,
  artifacts: readonly LongMemEvalEvidenceArtifact[],
  rawManifest: unknown
): void {
  const supplied = uniqueArtifacts(artifacts, manifest.profile);
  for (const expected of manifest.artifacts) {
    const actual = supplied.get(expected.path);
    if (actual === undefined) throw new Error(`missing artifact: ${expected.path}`);
    if (actual.role !== expected.role) throw new Error(`role mismatch: ${expected.path}`);
    const identity = artifactIdentity(actual);
    if (identity.sha256 !== expected.sha256) {
      throw new Error(`sha256 mismatch: ${expected.path}`);
    }
    if (identity.bytes !== expected.bytes) {
      throw new Error(`byte length mismatch: ${expected.path}`);
    }
  }
  if (supplied.size !== manifest.artifacts.length) {
    throw new Error("evidence artifact set differs from manifest");
  }
  const { bundle_sha256: _stored, ...unsigned } = rawManifest as
    Record<string, unknown>;
  if (sha256(JSON.stringify(unsigned)) !== manifest.bundle_sha256) {
    throw new Error("bundle sha256 mismatch");
  }
}

function uniqueArtifacts(
  artifacts: readonly LongMemEvalEvidenceArtifact[],
  profile: EvidenceManifest["profile"]
): ReadonlyMap<string, LongMemEvalEvidenceArtifact> {
  const supplied = new Map<string, LongMemEvalEvidenceArtifact>();
  for (const artifact of artifacts) {
    if (supplied.has(artifact.path)) throw new Error(`duplicate artifact: ${artifact.path}`);
    supplied.set(artifact.path, artifact);
  }
  const requiredRoles = profile === "recall_eval"
    ? REQUIRED_RECALL_EVAL_ROLES
    : REQUIRED_FULL_RUN_ROLES;
  for (const role of requiredRoles) {
    if (artifacts.filter((artifact) => artifact.role === role).length !== 1) {
      throw new Error(`complete evidence requires exactly one ${role} artifact`);
    }
  }
  if (profile === "recall_eval") {
    const allowedRoles = new Set<string>([
      ...REQUIRED_RECALL_EVAL_ROLES,
      ...OPTIONAL_RECALL_EVAL_ROLES
    ]);
    const unexpected = artifacts.find((artifact) => !allowedRoles.has(artifact.role));
    if (unexpected !== undefined) {
      throw new Error(`recall_eval evidence rejects unexpected ${unexpected.role} artifact`);
    }
    for (const role of OPTIONAL_RECALL_EVAL_ROLES) {
      if (artifacts.filter((artifact) => artifact.role === role).length > 1) {
        throw new Error(`recall_eval evidence allows at most one ${role} artifact`);
      }
    }
  }
  return supplied;
}

function assertManifestPayloadIdentity(
  manifest: EvidenceManifest,
  payload: KpiPayload
): void {
  const run = manifest.run;
  if (manifest.profile === "recall_eval" || run.bench_name !== payload.bench_name ||
      run.split !== payload.split || run.run_at !== payload.run_at ||
      run.alaya_commit !== payload.alaya_commit ||
      run.dataset_sha256 !== payload.dataset.checksum_sha256) {
    throw new Error("evidence manifest run identity differs from KPI");
  }
}

function readBindingArtifacts(artifacts: readonly LongMemEvalEvidenceArtifact[]) {
  return {
    kpi: KpiPayloadSchema.parse(parseRoleJson(artifacts, "kpi")),
    cohort: CohortLedgerSchema.parse(parseRoleJson(artifacts, "cohort_ledger")),
    provenance: RunProvenanceBindingSchema.parse(
      parseRoleJson(artifacts, "run_provenance")
    )
  };
}

const CohortLedgerSchema = z.object({
  question_count: z.number().int().nonnegative(),
  question_id_digest: Sha256Schema,
  selection_contract: LongMemEvalSelectionContractIdentitySchema,
  rows: z.array(z.object({
    question_id: z.string().min(1),
    dataset_cohort: z.enum(["answerable", "abstention"])
  }).passthrough())
}).passthrough();

function assertBoundKpi(payload: KpiPayload, bound: KpiPayload): void {
  if (canonicalJson(bound) !== canonicalJson(KpiPayloadSchema.parse(payload))) {
    throw new Error("evidence KPI bytes differ from promoted KPI");
  }
}

function assertCohortBinding(
  payload: KpiPayload,
  manifest: EvidenceManifest,
  cohort: z.infer<typeof CohortLedgerSchema>
): void {
  const ids = cohort.rows.map((row) => row.question_id);
  const assignments: LongMemEvalSelectionAssignment[] = cohort.rows.map((row) => ({
    question_id: row.question_id,
    dataset_cohort: row.dataset_cohort
  }));
  const expectedIds = payload.kpi.per_scenario.map((row) => row.id);
  if (canonicalJson(ids) !== canonicalJson(expectedIds) ||
      cohort.question_count !== payload.evaluated_count ||
      cohort.question_id_digest !== computeLongMemEvalQuestionIdDigest(ids) ||
      cohort.question_id_digest !== manifest.run.question_id_digest ||
      cohort.selection_contract.cohort_assignment_digest !==
        computeLongMemEvalCohortAssignmentDigest(assignments)) {
    throw new Error("cohort ledger identity differs from KPI or evidence manifest");
  }
}

interface ActualSelection {
  readonly dataset_sha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}

function assertExternalIdentity(
  payload: KpiPayload,
  artifacts: readonly LongMemEvalEvidenceArtifact[],
  manifest: EvidenceManifest,
  actualSelection: ActualSelection
): void {
  const selection = selectionIdentity(actualSelection);
  const identities = [
    payload.selection_contract,
    manifest.run.selection_contract,
    readSelectionFromRole(artifacts, "cohort_ledger"),
    readSelectionFromRole(artifacts, "run_provenance")
  ];
  const cohort = CohortLedgerSchema.parse(parseRoleJson(artifacts, "cohort_ledger"));
  const archivedAssignments = cohort.rows.map((row) => ({
    question_id: row.question_id,
    dataset_cohort: row.dataset_cohort
  }));
  if (actualSelection.dataset_sha256 !== manifest.run.dataset_sha256 ||
      canonicalJson(archivedAssignments) !== canonicalJson(actualSelection.assignments) ||
      identities.some((identity) => canonicalJson(identity) !== canonicalJson(selection))) {
    throw new Error("external dataset or selection identity differs from archived evidence");
  }
}

function selectionIdentity(
  actualSelection: ActualSelection
): LongMemEvalSelectionContractIdentity {
  return createLongMemEvalSelectionContractIdentity({
    datasetSha256: actualSelection.dataset_sha256,
    assignments: actualSelection.assignments
  });
}

function readSelectionFromRole(
  artifacts: readonly LongMemEvalEvidenceArtifact[],
  role: "cohort_ledger" | "run_provenance"
): unknown {
  const value = parseRoleJson(artifacts, role) as Record<string, unknown>;
  if (role === "cohort_ledger") return value.selection_contract;
  return value.selection ?? value.selection_contract;
}

function parseRoleJson(
  artifacts: readonly LongMemEvalEvidenceArtifact[],
  role: string
): unknown {
  const artifact = artifacts.find((item) => item.role === role);
  if (artifact === undefined) throw new Error(`missing ${role} artifact bytes`);
  if (artifact.contents === undefined) {
    throw new Error(`missing ${artifact.role} artifact bytes`);
  }
  const text = typeof artifact.contents === "string"
    ? artifact.contents
    : Buffer.from(artifact.contents).toString("utf8");
  return JSON.parse(text) as unknown;
}

function payloadIdentity(payload: KpiPayload): string {
  return sha256(canonicalJson(KpiPayloadSchema.parse(payload)));
}

const MIB = 1024 * 1024;
const EVIDENCE_ARTIFACT_LIMITS = {
  manifest: 4 * MIB,
  kpi: 16 * MIB,
  report: 16 * MIB,
  findings: 16 * MIB,
  diagnostics: 64 * MIB,
  full_diagnostics: 256 * MIB,
  cohort_ledger: 64 * MIB,
  comparison: 64 * MIB,
  run_provenance: 4 * MIB,
  shard_run_provenance: 4 * MIB,
  extraction_authority: 64 * MIB,
  fanout_authority: MIB,
  extraction_authority_ref: MIB,
  shard_extraction_authority_ref: MIB,
  rank_identity: 16 * MIB,
  recall_eval_diagnostics: 64 * MIB,
  stage_ledger: 64 * MIB,
  oracle_derivation: 16 * MIB
} as const;
type EvidenceReadRole = keyof typeof EVIDENCE_ARTIFACT_LIMITS;

function evidenceReadRole(role: string): EvidenceReadRole {
  if (Object.prototype.hasOwnProperty.call(EVIDENCE_ARTIFACT_LIMITS, role)) {
    return role as EvidenceReadRole;
  }
  throw new Error(`LongMemEval evidence rejects unsupported ${role} artifact`);
}

function artifactIdentity(artifact: LongMemEvalEvidenceArtifact) {
  if (artifact.identity !== undefined) return artifact.identity;
  const contents = artifact.contents;
  return {
    sha256: sha256(contents),
    bytes: typeof contents === "string"
      ? Buffer.byteLength(contents, "utf8")
      : contents.byteLength
  };
}

function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
