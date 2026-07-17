import { createHash } from "node:crypto";
import {
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  verifyLongMemEvalEvidenceArtifactIntegrity
} from "@do-soul/alaya-eval";
import type { LongMemEvalSelectionContractIdentity } from "../selection/contract.js";

export { LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME };

export type LongMemEvalEvidenceArtifactRole =
  | "kpi"
  | "report"
  | "findings"
  | "diagnostics"
  | "full_diagnostics"
  | "cohort_ledger"
  | "comparison"
  | "run_provenance"
  | "shard_run_provenance"
  | "extraction_authority"
  | "fanout_authority"
  | "extraction_authority_ref"
  | "shard_extraction_authority_ref"
  | "rank_identity"
  | "recall_eval_diagnostics"
  | "stage_ledger"
  | "oracle_derivation";

interface LongMemEvalEvidenceArtifactBase {
  readonly role: LongMemEvalEvidenceArtifactRole;
  readonly path: string;
}

export type LongMemEvalEvidenceArtifactInput = LongMemEvalEvidenceArtifactBase & (
  | { readonly contents: string | Uint8Array; readonly identity?: never }
  | {
      readonly contents?: never;
      readonly identity: { readonly sha256: string; readonly bytes: number };
    }
);

export interface LongMemEvalEvidenceManifest {
  readonly schema_version: 1;
  readonly kind: "longmemeval_evidence_bundle";
  readonly profile?: "full_run" | "recall_eval";
  readonly run: {
    readonly slug: string;
    readonly bench_name: string;
    readonly split: string;
    readonly run_at: string;
    readonly alaya_commit: string;
    readonly dataset_sha256: string;
    readonly selection_manifest_sha256: string | null;
    readonly question_id_digest: string;
    readonly selection_contract?: LongMemEvalSelectionContractIdentity;
    readonly candidate_pool_complete: boolean;
    readonly provenance_complete?: boolean;
  };
  readonly evidence_status: "complete" | "partial";
  readonly artifacts: readonly {
    readonly role: LongMemEvalEvidenceArtifactRole;
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly bundle_sha256: string;
}

export function buildLongMemEvalEvidenceManifest(input: {
  readonly profile?: "full_run" | "recall_eval";
  readonly run: LongMemEvalEvidenceManifest["run"];
  readonly artifacts: readonly LongMemEvalEvidenceArtifactInput[];
}): LongMemEvalEvidenceManifest {
  assertRunBindings(input.run);
  assertUniqueArtifactPaths(input.artifacts);
  const artifacts = input.artifacts.map(renderArtifactIdentity);
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval_evidence_bundle" as const,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    run: input.run,
    evidence_status: evidenceIsComplete(input.run, input.artifacts, input.profile)
      ? "complete" as const
      : "partial" as const,
    artifacts
  };
  return { ...unsigned, bundle_sha256: sha256(JSON.stringify(unsigned)) };
}

const REQUIRED_EVIDENCE_ROLES = [
  "kpi",
  "report",
  "diagnostics",
  "full_diagnostics",
  "cohort_ledger",
  "comparison",
  "run_provenance"
] as const;

const REQUIRED_RECALL_EVAL_EVIDENCE_ROLES = [
  "kpi",
  "report",
  "rank_identity",
  "run_provenance",
  "recall_eval_diagnostics"
] as const;

function evidenceIsComplete(
  run: LongMemEvalEvidenceManifest["run"],
  artifacts: readonly LongMemEvalEvidenceArtifactInput[],
  profile: "full_run" | "recall_eval" | undefined
): boolean {
  if (!run.candidate_pool_complete || run.provenance_complete !== true) return false;
  if (profile === "recall_eval" && run.selection_contract === undefined) return false;
  const roles = new Set(artifacts.map((artifact) => artifact.role));
  const required = profile === "recall_eval"
    ? REQUIRED_RECALL_EVAL_EVIDENCE_ROLES
    : REQUIRED_EVIDENCE_ROLES;
  return required.every((role) => roles.has(role));
}

function assertRunBindings(run: LongMemEvalEvidenceManifest["run"]): void {
  for (const [field, value] of [
    ["dataset_sha256", run.dataset_sha256],
    ["question_id_digest", run.question_id_digest],
    ["selection_manifest_sha256", run.selection_manifest_sha256]
  ] as const) {
    if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`LongMemEval evidence manifest has invalid ${field}`);
    }
  }
  const selection = run.selection_contract;
  if (selection !== undefined && (
    selection.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(selection.selected_id_digest) ||
    !/^[a-f0-9]{64}$/u.test(selection.cohort_assignment_digest) ||
    selection.dataset_sha256 !== run.dataset_sha256 ||
    selection.selected_id_digest !== run.question_id_digest ||
    selection.selected_count !==
      selection.expected_cohort_counts.answerable +
      selection.expected_cohort_counts.abstention
  )) {
    throw new Error("LongMemEval evidence manifest selection binding mismatch");
  }
}

export function verifyLongMemEvalEvidenceManifest(
  manifest: LongMemEvalEvidenceManifest,
  artifacts: readonly LongMemEvalEvidenceArtifactInput[]
): { readonly valid: boolean; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const supplied = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  for (const expected of manifest.artifacts) {
    const actual = supplied.get(expected.path);
    if (actual === undefined) errors.push(`missing artifact: ${expected.path}`);
    else if (actual.role !== expected.role) errors.push(`role mismatch: ${expected.path}`);
    else if (artifactIdentity(actual).sha256 !== expected.sha256) errors.push(`sha256 mismatch: ${expected.path}`);
    else if (artifactIdentity(actual).bytes !== expected.bytes) {
      errors.push(`byte length mismatch: ${expected.path}`);
    }
  }
  for (const actual of artifacts) {
    if (!manifest.artifacts.some((expected) => expected.path === actual.path)) {
      errors.push(`unexpected artifact: ${actual.path}`);
    }
  }
  const { bundle_sha256: _stored, ...unsigned } = manifest;
  if (sha256(JSON.stringify(unsigned)) !== manifest.bundle_sha256) {
    errors.push("bundle sha256 mismatch");
  }
  if (manifest.evidence_status === "complete" &&
      manifest.run.selection_contract !== undefined) {
    const shared = verifyLongMemEvalEvidenceArtifactIntegrity(manifest, artifacts);
    errors.push(...shared.errors.filter((error) => !errors.includes(error)));
  }
  return { valid: errors.length === 0, errors };
}

function renderArtifactIdentity(artifact: LongMemEvalEvidenceArtifactInput) {
  return { role: artifact.role, path: artifact.path, ...artifactIdentity(artifact) };
}

function artifactIdentity(
  artifact: LongMemEvalEvidenceArtifactInput
): { readonly sha256: string; readonly bytes: number } {
  if (artifact.identity !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(artifact.identity.sha256) ||
      !Number.isSafeInteger(artifact.identity.bytes) || artifact.identity.bytes < 0) {
      throw new Error(`invalid precomputed artifact identity: ${artifact.path}`);
    }
    return artifact.identity;
  }
  return {
    sha256: sha256(artifact.contents),
    bytes: artifactByteLength(artifact.contents)
  };
}

export function renderLongMemEvalEvidenceManifest(
  manifest: LongMemEvalEvidenceManifest
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function assertUniqueArtifactPaths(
  artifacts: readonly LongMemEvalEvidenceArtifactInput[]
): void {
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    assertSafeArtifactReference(artifact.path);
    if (paths.has(artifact.path)) throw new Error(`duplicate evidence artifact path: ${artifact.path}`);
    paths.add(artifact.path);
  }
}

function assertSafeArtifactReference(reference: string): void {
  if (reference.length === 0 || reference.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/u.test(reference) || reference.split(/[\\/]/u).includes("..")) {
    throw new Error(`unsafe evidence artifact path: ${reference}`);
  }
}

function artifactByteLength(contents: string | Uint8Array): number {
  return typeof contents === "string" ? Buffer.byteLength(contents, "utf8") : contents.byteLength;
}

function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
