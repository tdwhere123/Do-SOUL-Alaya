import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalJson, RequestBudgetSchema, AuthorizedScopesAdmissionSchema,
  SourceSemanticQuerySchema, SourceSemanticHandleDescriptorSchema, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SemanticProposalWorksetSchema } from "../semantic-proposal/workset.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { restoreSnapshotToDataDir } from "../snapshot/materialize.js";
import { startBenchDaemon, type BenchDaemonHandle } from "../../harness/daemon.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { isAuthorityRevision } from "../extraction/authority/receipt.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const SemanticChainConfigSchema = z.object({
  snapshot_path: z.string().min(1), snapshot_sha256: Digest,
  implementation_revision: z.string().refine(isAuthorityRevision), interpretation_clock: z.string().datetime(),
  workspace_id: z.string().min(1), run_id: z.string().min(1),
  query_workset: SemanticProposalWorksetSchema.refine((value) => value.kind === "query", "query workset required"),
  query_cache_root: z.string().min(1), alignment_cache_root: z.string().min(1),
  max_output_tokens: z.number().int().min(1).max(65536),
  discovery_page_cap: z.number().int().min(1).max(64),
  alignment_pair_cap: z.number().int().min(0).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP),
  budget: RequestBudgetSchema, authorized_scopes: AuthorizedScopesAdmissionSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict();
export type SemanticChainConfig = z.infer<typeof SemanticChainConfigSchema>;

const QueryBase = { query_key: Digest, original_query: z.string(), raw_digest: Digest.nullable() };
export const SemanticChainQuerySchema = z.discriminatedUnion("status", [
  z.object({ ...QueryBase, status: z.literal("blocked"), reason: z.string() }).strict(),
  z.object({ ...QueryBase, status: z.literal("ready"), q: SourceSemanticQuerySchema,
    descriptors: z.array(SourceSemanticHandleDescriptorSchema), selected_h_ids: z.array(z.string()),
    discovery_pages: z.number().int().nonnegative(), discovery_open: z.boolean(),
    unvisited_h_count: z.null(), discovery_truncated: z.boolean()
  }).strict()
]);
export const SemanticChainPlanSchema = z.object({
  contract: z.literal("source-semantic-chain-plan-v1"), input_identity: Digest,
  config: SemanticChainConfigSchema, queries: z.array(SemanticChainQuerySchema),
  alignment_workset: SemanticProposalWorksetSchema.nullable()
}).strict();
export type SemanticChainPlan = z.infer<typeof SemanticChainPlanSchema>;
export const chainIdentity = (value: unknown): string => fieldContractSha256(canonicalJson(value));

export function readChainArtifact(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  const envelope = z.object({ identity: Digest, payload: z.unknown() }).strict().parse(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path, maxBytes: 32 * 1024 * 1024, label: "semantic chain artifact" })
  ));
  if (chainIdentity(envelope.payload) !== envelope.identity) throw new Error("semantic chain artifact identity mismatch");
  return envelope.payload;
}

export function writeChainArtifact(path: string, payload: unknown): void {
  const identity = chainIdentity(payload);
  const existing = readChainArtifact(path);
  if (existing !== undefined) {
    if (chainIdentity(existing) !== identity) throw new Error("immutable semantic chain stage conflict");
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  publishBytesExclusiveDurable({ destination: path, bytes: Buffer.from(JSON.stringify({ identity, payload })),
    ownerIdentity: identity, temporaryDirectory: dirname(path), allowExistingExact: true });
}

export function writeChainJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  publishBytesExclusiveDurable({ destination: path, bytes: Buffer.from(JSON.stringify(value)),
    ownerIdentity: chainIdentity(value), temporaryDirectory: dirname(path), allowExistingExact: true });
}

export function assertChainSnapshot(config: SemanticChainConfig): void {
  if (hashRegularFileNoFollow(config.snapshot_path) !== config.snapshot_sha256) throw new Error("semantic chain snapshot changed");
  if (readCurrentExtractionAuthorityRevision() !== config.implementation_revision) throw new Error("semantic chain implementation changed");
}

export async function withSemanticChainDaemon<T>(config: SemanticChainConfig, root: string,
  body: (daemon: BenchDaemonHandle) => Promise<T>): Promise<T> {
  assertChainSnapshot(config);
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "native-session-"));
  let daemon: BenchDaemonHandle | undefined;
  let complete = false;
  try {
    restoreSnapshotToDataDir({ snapshotDbPath: config.snapshot_path, expectedSha256: config.snapshot_sha256, dataDirRoot: directory });
    daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId: config.workspace_id, runId: config.run_id,
      sourceSemanticInterpretationClock: config.interpretation_clock,
      embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    const result = await body(daemon);
    complete = true;
    return result;
  } finally {
    await daemon?.shutdown();
    if (complete) rmSync(directory, { recursive: true, force: true });
  }
}
