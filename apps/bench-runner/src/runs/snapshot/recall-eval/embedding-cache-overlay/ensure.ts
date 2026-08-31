import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { snapshotManifestPath } from "../../materialize.js";
import {
  readEmbeddingCacheOverlayReceipt,
  sameVectorSpace,
  type EmbeddingCacheVectorSpaceExpectation
} from "./contract.js";
import {
  emitProductOverlayForSnapshot,
  isProductOverlayUnavailable,
  productOverlayAdmissionOpen
} from "./product-emit.js";

type OverlayEmitCounts = {
  readonly memory_embedding_count: number;
  readonly evidence_embedding_count: number;
};

export type OverlayEmitFn = (receiptPath: string) => Promise<OverlayEmitCounts>;

export function defaultSnapshotOverlayReceiptPath(snapshotDbPath: string): string {
  const resolved = resolve(snapshotDbPath);
  const extension = extname(resolved);
  const stem = basename(resolved, extension);
  return join(dirname(resolved), `${stem}.embedding-cache-overlay.json`);
}

async function inspectExistingOverlayReceipt(input: {
  readonly snapshotDbPath: string;
  readonly receiptPath: string;
  readonly expectedVectorSpace?: EmbeddingCacheVectorSpaceExpectation;
}): Promise<"missing" | "match" | "mismatch"> {
  if (!existsSync(input.receiptPath)) return "missing";
  const receipt = readEmbeddingCacheOverlayReceipt(input.receiptPath);
  if (receipt.source.snapshot_db_sha256 !== sealedSnapshotDbSha256(input.snapshotDbPath)) {
    return "mismatch";
  }
  if (
    input.expectedVectorSpace !== undefined &&
    !sameVectorSpace(receipt.vector_space, input.expectedVectorSpace)
  ) {
    throw new Error("embedding cache overlay vector space binding mismatch");
  }
  const overlayPath = resolve(dirname(input.receiptPath), receipt.overlay.path);
  if (!existsSync(overlayPath)) {
    throw new Error("embedding cache overlay sidecar is missing");
  }
  return "match";
}

// Overlay emit is the once-per-snapshot document encode; question warmup must not MiniLM-encode the haystack.
export async function ensureTreatmentOverlayReceipt(input: {
  readonly snapshotDbPath: string;
  readonly receiptPathOverride?: string;
  readonly expectedVectorSpace?: EmbeddingCacheVectorSpaceExpectation;
  readonly emit: OverlayEmitFn;
}): Promise<string> {
  const receiptPath = input.receiptPathOverride ??
    defaultSnapshotOverlayReceiptPath(input.snapshotDbPath);
  const existing = await inspectExistingOverlayReceipt({
    snapshotDbPath: input.snapshotDbPath,
    receiptPath,
    ...(input.expectedVectorSpace === undefined
      ? {}
      : { expectedVectorSpace: input.expectedVectorSpace })
  });
  if (existing === "match") return receiptPath;
  if (existing === "mismatch") {
    throw new Error("embedding cache overlay receipt snapshot SHA-256 binding mismatch");
  }
  const emitted = await input.emit(receiptPath);
  if (emitted.memory_embedding_count + emitted.evidence_embedding_count === 0) {
    throw new Error("embedding cache overlay emit produced no vectors");
  }
  return receiptPath;
}

export async function resolveTreatmentOverlayReceipt(input: {
  readonly snapshotDbPath: string;
  readonly receiptPathOverride?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly emit?: OverlayEmitFn;
  readonly expectedVectorSpace?: EmbeddingCacheVectorSpaceExpectation;
}): Promise<string> {
  const env = input.env ?? process.env;
  return ensureTreatmentOverlayReceipt({
    snapshotDbPath: input.snapshotDbPath,
    ...(input.receiptPathOverride === undefined
      ? {}
      : { receiptPathOverride: input.receiptPathOverride }),
    ...(input.expectedVectorSpace === undefined
      ? {}
      : { expectedVectorSpace: input.expectedVectorSpace }),
    emit: input.emit ?? productEmitFor(input.snapshotDbPath, env)
  });
}

export async function maybeEmitSnapshotEmbeddingOverlay(input: {
  readonly snapshotDbPath: string;
  readonly receiptPathOverride?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly emit?: OverlayEmitFn;
}): Promise<string | null> {
  const env = input.env ?? process.env;
  if (input.receiptPathOverride !== undefined) {
    return inspectOverrideOrNull(input.snapshotDbPath, input.receiptPathOverride);
  }
  const receiptPath = defaultSnapshotOverlayReceiptPath(input.snapshotDbPath);
  const existing = await inspectExistingOverlayReceipt({
    snapshotDbPath: input.snapshotDbPath,
    receiptPath
  });
  if (existing === "match") return receiptPath;
  if (existing === "mismatch") {
    throw new Error("embedding cache overlay receipt snapshot SHA-256 binding mismatch");
  }
  if (input.emit === undefined && !productOverlayAdmissionOpen(env)) {
    return null;
  }
  try {
    return await ensureTreatmentOverlayReceipt({
      snapshotDbPath: input.snapshotDbPath,
      receiptPathOverride: receiptPath,
      emit: input.emit ?? productEmitFor(input.snapshotDbPath, env)
    });
  } catch (error) {
    if (input.emit === undefined && isProductOverlayUnavailable(error)) {
      return null;
    }
    throw error;
  }
}

async function inspectOverrideOrNull(
  snapshotDbPath: string,
  receiptPath: string
): Promise<string | null> {
  const existing = await inspectExistingOverlayReceipt({ snapshotDbPath, receiptPath });
  if (existing === "match") return receiptPath;
  if (existing === "mismatch") {
    throw new Error("embedding cache overlay receipt snapshot SHA-256 binding mismatch");
  }
  return null;
}

function sealedSnapshotDbSha256(snapshotDbPath: string): string {
  const manifestPath = snapshotManifestPath(snapshotDbPath);
  if (!existsSync(manifestPath)) {
    throw new Error("embedding cache overlay inspect requires snapshot artifact integrity");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly artifact_integrity?: { readonly db_sha256?: string };
  };
  const digest = manifest.artifact_integrity?.db_sha256;
  if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("embedding cache overlay inspect requires snapshot artifact integrity");
  }
  return digest;
}

function productEmitFor(
  snapshotDbPath: string,
  env: Readonly<Record<string, string | undefined>>
): OverlayEmitFn {
  return async (receiptPath) => emitProductOverlayForSnapshot({
    snapshotDbPath,
    receiptPath,
    env
  });
}
