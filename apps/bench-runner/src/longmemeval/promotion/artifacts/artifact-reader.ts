import { createHash } from "node:crypto";
import type { ContainedArtifactFile } from "../../../cli/merge/contained-artifact-path.js";
import { openContainedArtifact } from "../../../cli/merge/contained-artifact-path.js";
import {
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  verifyLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput,
  type LongMemEvalEvidenceManifest
} from "../../provenance/evidence-manifest.js";
import {
  RecallEvalPromotionManifestSchema,
  type RecallEvalPromotionManifest
} from "../schema/evidence-schema.js";
import {
  MAX_RECALL_EVAL_PROMOTION_MANIFEST_BYTES,
  assertRecallEvalOpenedArtifactSize,
  assertRecallEvalPromotionArtifactBudgets,
  recallEvalPromotionArtifactByteLimit
} from "./artifact-limits.js";

export interface RecallEvalSmallArtifacts {
  readonly byRole: ReadonlyMap<string, Buffer>;
  readonly identities: readonly LongMemEvalEvidenceArtifactInput[];
}

export async function readRecallEvalPromotionManifest(
  entryRoot: string
): Promise<RecallEvalPromotionManifest> {
  const file = await requireContainedArtifact(
    entryRoot,
    LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME
  );
  try {
    const text = await file.readUtf8(MAX_RECALL_EVAL_PROMOTION_MANIFEST_BYTES);
    const manifest = RecallEvalPromotionManifestSchema.parse(
      JSON.parse(text) as unknown
    );
    assertRecallEvalPromotionArtifactBudgets(manifest);
    return manifest;
  } finally {
    await file.close();
  }
}

export async function readRecallEvalSmallArtifacts(
  entryRoot: string,
  manifest: RecallEvalPromotionManifest
): Promise<RecallEvalSmallArtifacts> {
  assertRecallEvalPromotionArtifactBudgets(manifest);
  const byRole = new Map<string, Buffer>();
  const identities: LongMemEvalEvidenceArtifactInput[] = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.role === "recall_eval_diagnostics") continue;
    const file = await requireContainedArtifact(entryRoot, artifact.path);
    try {
      assertRecallEvalOpenedArtifactSize(artifact, file);
      const contents = await file.readBytes(
        recallEvalPromotionArtifactByteLimit(artifact.role)
      );
      assertExpectedIdentity(artifact, contents.byteLength, sha256(contents));
      if (byRole.has(artifact.role)) {
        throw new Error(`duplicate recall-eval ${artifact.role} artifact`);
      }
      byRole.set(artifact.role, contents);
      identities.push({
        role: artifact.role,
        path: artifact.path,
        identity: { sha256: artifact.sha256, bytes: artifact.bytes }
      });
    } finally {
      await file.close();
    }
  }
  return { byRole, identities };
}

export async function openRecallEvalDiagnosticsArtifact(
  entryRoot: string,
  manifest: RecallEvalPromotionManifest
): Promise<{
  readonly file: ContainedArtifactFile;
  readonly artifact: RecallEvalPromotionManifest["artifacts"][number];
}> {
  const matches = manifest.artifacts.filter(
    (artifact) => artifact.role === "recall_eval_diagnostics"
  );
  if (matches.length !== 1) {
    throw new Error("recall-eval evidence requires exactly one diagnostics artifact");
  }
  const artifact = matches[0]!;
  assertRecallEvalPromotionArtifactBudgets(manifest);
  const file = await requireContainedArtifact(entryRoot, artifact.path);
  try {
    assertRecallEvalOpenedArtifactSize(artifact, file);
    return { file, artifact };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function verifyRecallEvalArtifactSet(
  manifest: RecallEvalPromotionManifest,
  identities: readonly LongMemEvalEvidenceArtifactInput[]
): void {
  const result = verifyLongMemEvalEvidenceManifest(
    manifest as LongMemEvalEvidenceManifest,
    identities
  );
  if (!result.valid) {
    throw new Error(`recall-eval evidence integrity failed: ${result.errors.join("; ")}`);
  }
}

export function parseJsonArtifact(bytes: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid UTF-8: ${detail}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

export function requiredArtifactBytes(
  artifacts: RecallEvalSmallArtifacts,
  role: "kpi" | "rank_identity" | "run_provenance"
): Buffer {
  const bytes = artifacts.byRole.get(role);
  if (bytes === undefined) throw new Error(`missing recall-eval ${role} artifact`);
  return bytes;
}

export function assertExpectedIdentity(
  artifact: RecallEvalPromotionManifest["artifacts"][number],
  bytes: number,
  digest: string
): void {
  if (bytes !== artifact.bytes) {
    throw new Error(`byte length mismatch: ${artifact.path}`);
  }
  if (digest !== artifact.sha256) {
    throw new Error(`sha256 mismatch: ${artifact.path}`);
  }
}

async function requireContainedArtifact(
  root: string,
  reference: string
): Promise<ContainedArtifactFile> {
  const file = await openContainedArtifact(root, reference);
  if (file === null) throw new Error(`missing artifact: ${reference}`);
  return file;
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
