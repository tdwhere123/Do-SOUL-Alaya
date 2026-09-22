import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { SourceSemanticAccessPolicySchema } from "@do-soul/alaya-protocol";
import { prepareSemanticChain } from "../semantic-chain/prepare.js";
import { replaySemanticChain } from "../semantic-chain/replay.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainArtifact, writeChainJson } from "../semantic-chain/contract.js";
import { SemanticProposalWorksetSchema, parseSemanticProposalWorkset, SEMANTIC_PROPOSAL_WORKSET_CONTRACT } from "../semantic-proposal/workset.js";
import { readSemanticChainProposalResults } from "../semantic-chain/inputs.js";
import { publishSourceSemanticSnapshot } from "../snapshot/source-records/publish.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { assertLongMemEvalSemanticRows, loadFrozenLongMemEvalDataset, readLongMemEvalSemanticFreeze,
  type LongMemEvalSemanticFreeze } from "./contract.js";
import { assertSourceCaches } from "./native-arm.js";

const QuestionPublicationSchema = z.object({ workspace_id: z.string(), run_id: z.string(), recorded_at: z.string(),
  snapshot_path: z.string(), db_sha256: z.string(), census_count: z.number(), admitted_count: z.number(), published_count: z.number().int().nonnegative(),
  sources: z.array(z.object({ question_id: z.string(), session_id: z.string(), source_id: z.string(), source_version: z.string(),
    content_digest: z.string(), corpus_digest: z.string(), admission: z.enum(["admitted", "rejected"]), record_id: z.string().optional()
  }).passthrough())
}).passthrough();
export const LongMemEvalPublicationSchema = QuestionPublicationSchema.extend({ published_count: z.literal(0) }).superRefine((report, ctx) => {
  if (report.sources.some((source) => source.publication === "published")) {
    ctx.addIssue({ code: "custom", path: ["sources"], message: "source-only publication cannot contain a published interpretation" });
  }
});
/** This frozen arm never executes a published interpretation; generic semantic-chain replay may do so. */
export const LongMemEvalSourceOnlyResponseSchema = z.object({ proofs: z.array(z.never()).optional() }).passthrough();
export const LongMemEvalSourceOnlyReplaySchema = z.object({ rows: z.array(z.object({
  response: LongMemEvalSourceOnlyResponseSchema.nullish()
}).passthrough()) }).passthrough();
const Unavailable = z.object({ question_id: z.string(), status: z.literal("unavailable"), reason: z.string() }).strict();
export const LongMemEvalPreparedSchema = z.object({ contract: z.literal("longmemeval-semantic-prepared-v1"),
  freeze_identity: z.string(), rows: z.array(z.discriminatedUnion("status", [Unavailable,
    z.object({ question_id: z.string(), status: z.literal("prepared"), chain_root: z.string(), publication_path: z.string(), publication_identity: z.string() }).strict()
  ])) }).strict();
export const LongMemEvalReplaySchema = z.object({ contract: z.literal("longmemeval-semantic-replay-v1"),
  freeze_identity: z.string(), prepared_identity: z.string(), provider_calls: z.literal(0),
  rows: z.array(z.discriminatedUnion("status", [Unavailable,
    z.object({ question_id: z.string(), status: z.literal("replayed"), chain_root: z.string(), publication_path: z.string(), publication_identity: z.string(), replay_path: z.string() }).strict()
  ])) }).strict();
const NativePreparedSchema = LongMemEvalPreparedSchema.extend({ contract: z.literal("longmemeval-native-semantic-prepared-v1"),
  correspondence_workset: SemanticProposalWorksetSchema.nullable() }).strict();
const ExperimentPreparedSchema = z.discriminatedUnion("contract", [LongMemEvalPreparedSchema, NativePreparedSchema]);
const NativeReplaySchema = LongMemEvalReplaySchema.extend({ contract: z.literal("longmemeval-native-semantic-replay-v1") }).strict();
export const LongMemEvalExperimentReplaySchema = z.discriminatedUnion("contract", [LongMemEvalReplaySchema, NativeReplaySchema]);

export async function prepareLongMemEvalSemanticRun(root: string) {
  const frozen = readLongMemEvalSemanticFreeze(root);
  await loadFrozenLongMemEvalDataset(frozen.config);
  if (frozen.contract === "longmemeval-native-semantic-v1") assertSourceCaches(frozen.source_caches);
  const results = readSemanticChainProposalResults(frozen.query_workset, frozen.config.query_cache_root, frozen.config.max_output_tokens);
  const rows: z.infer<typeof LongMemEvalPreparedSchema>["rows"] = [];
  for (const [index, selected] of frozen.selected.entries()) {
    try {
      const directory = resolve(root, "questions", String(selected.index).padStart(5, "0"));
      const publicationPath = join(directory, "publication.json");
      const publication = await publishQuestion(frozen, selected, directory, publicationPath);
      const current = results[index]!;
      if (current.line.key !== selected.query_key) throw new Error("frozen query request identity changed");
      const chainRoot = join(directory, `chain-${chainIdentity({ key: current.line.key, cache_identity: current.cache_identity, status: current.status })}`);
      await prepareSemanticChain(questionChainConfig(frozen, selected, directory, publication), chainRoot);
      rows.push({ question_id: selected.question_id, status: "prepared", chain_root: chainRoot,
        publication_path: publicationPath, publication_identity: chainIdentity(publication) });
    } catch (error) { rows.push({ question_id: selected.question_id, status: "unavailable", reason: error instanceof Error ? error.message : String(error) }); }
  }
  const native = frozen.contract === "longmemeval-native-semantic-v1";
  const items = native ? rows.flatMap((row) => row.status !== "prepared" ? []
    : SemanticChainPlanSchema.parse(readChainArtifact(join(row.chain_root, "prepare.json"))).correspondence_workset?.items ?? []) : [];
  const workset = items.length === 0 ? null : parseSemanticProposalWorkset({ contract: SEMANTIC_PROPOSAL_WORKSET_CONTRACT,
    kind: "semantic_correspondence", model: frozen.config.model, request_profile: frozen.config.request_profile, items });
  const result = ExperimentPreparedSchema.parse({ contract: native ? "longmemeval-native-semantic-prepared-v1" : "longmemeval-semantic-prepared-v1",
    freeze_identity: chainIdentity(frozen), rows, ...(native ? { correspondence_workset: workset } : {}) });
  if (workset !== null) writeChainJson(join(root, `semantic_correspondence-workset-${chainIdentity(workset)}.json`), workset);
  const path = join(root, `prepared-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result); return { path, result };
}

async function publishQuestion(frozen: LongMemEvalSemanticFreeze, selected: LongMemEvalSemanticFreeze["selected"][number],
  directory: string, publicationPath: string) {
  const { config } = frozen;
  const snapshotPath = join(directory, "library.sqlite");
  writeChainArtifact(join(directory, "publication-input.json"), { freeze_identity: chainIdentity(frozen), question_id: selected.question_id });
  let retained = readChainArtifact(publicationPath);
  if (retained === undefined) {
    const nativeReport = `${snapshotPath}.publication.json`;
    if (existsSync(nativeReport)) retained = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: nativeReport, maxBytes: 32 * 1024 * 1024, label: "completed question publication" }));
    else {
      if (!isExtractionRequestProfile(config.request_profile)) throw new Error("unsupported request profile");
      retained = await publishSourceSemanticSnapshot({ snapshotPath,
      dataDirRoot: join(directory, "publication-runtime"), recordedAt: config.recorded_at, producerCommit: config.producer_commit,
      workspaceId: questionWorkspace(frozen, selected.index), runId: questionWorkspace(frozen, selected.index),
      populations: [{ name: "longmemeval_s", dataDir: config.data_dir, pinnedMetaRoot: config.pinned_meta_root,
        questionWindow: { offset: selected.index, limit: 1 }, model: config.model, requestProfile: config.request_profile,
        ...("arm" in config ? { cacheRoots: config.source_cache_roots,
          publicationAssociations: config.source_publication_associations.filter((association) =>
            selected.source_manifest.some((source) => source.source_id === association.source_id)) } : {}) }] });
    }
  }
  const report = verifyLongMemEvalQuestionPublication(frozen, selected, directory, retained);
  writeChainArtifact(publicationPath, retained);
  return report;
}

/** Both preparation and evaluator joins must bind the exact original question inventory. */
export function verifyLongMemEvalQuestionPublication(frozen: LongMemEvalSemanticFreeze,
  selected: LongMemEvalSemanticFreeze["selected"][number], directory: string, value: unknown) {
  const { config } = frozen;
  const snapshotPath = join(directory, "library.sqlite");
  const report = (frozen.contract === "longmemeval-native-semantic-v1" ? QuestionPublicationSchema : LongMemEvalPublicationSchema).parse(value);
  if (report.snapshot_path !== snapshotPath || report.recorded_at !== config.recorded_at
    || report.workspace_id !== questionWorkspace(frozen, selected.index)
    || report.run_id !== questionWorkspace(frozen, selected.index)) throw new Error("question publication identity changed");
  if (hashRegularFileNoFollow(report.snapshot_path) !== report.db_sha256) throw new Error("question snapshot changed");
  const identity = (rows: readonly { source_id: string; source_version: string; content_digest: string; session_id: string }[]) =>
    chainIdentity(rows.map(({ source_id, source_version, content_digest, session_id }) => ({ source_id, source_version, content_digest, session_id })));
  if (report.census_count !== selected.source_manifest.length || report.sources.some((row) => row.question_id !== selected.question_id)
    || identity(report.sources) !== identity(selected.source_manifest)) throw new Error("publication changed the complete question haystack");
  return report;
}

function questionWorkspace(frozen: LongMemEvalSemanticFreeze, index: number): string {
  return `${"arm" in frozen.config ? frozen.config.workspace_prefix : "longmemeval-semantic"}-${index}`;
}

function questionChainConfig(frozen: LongMemEvalSemanticFreeze, selected: LongMemEvalSemanticFreeze["selected"][number],
  directory: string, publication: z.infer<typeof QuestionPublicationSchema>) {
  const { config } = frozen;
  const index = frozen.selected.findIndex((row) => row.question_id === selected.question_id);
  return { snapshot_path: publication.snapshot_path, snapshot_sha256: publication.db_sha256,
    implementation_revision: frozen.implementation_revision, interpretation_clock: selected.interpretation_clock,
    workspace_id: publication.workspace_id, run_id: publication.run_id,
    query_workset: { ...frozen.query_workset, items: [frozen.query_workset.items[index]] },
    query_cache_root: config.query_cache_root, correspondence_cache_root: "arm" in config
      ? config.correspondence_cache_root : join(directory, "semantic_correspondence-cache"),
    max_output_tokens: config.max_output_tokens, discovery_page_cap: "arm" in config ? config.discovery_page_cap : 1,
    correspondence_pair_cap: "arm" in config ? config.correspondence_pair_cap : 0,
    access_policy: frozen.contract === "longmemeval-native-semantic-v1" ? frozen.native_route.access_policy
      : SourceSemanticAccessPolicySchema.enum["canonical-v1"],
    budget: config.budget, output_byte_limit: config.output_byte_limit,
    authorized_scopes: "arm" in config ? config.authorized_scopes : { mode: "named", scopes: ["project"] } };
}

/** Replay and measurement must use the prepared native request fixed by this question's freeze. */
export function verifyLongMemEvalQuestionChain(frozen: LongMemEvalSemanticFreeze,
  selected: LongMemEvalSemanticFreeze["selected"][number], directory: string,
  publication: z.infer<typeof QuestionPublicationSchema>, chainRoot: string) {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(chainRoot, "prepare.json")));
  if (chainIdentity(plan.config) !== chainIdentity(questionChainConfig(frozen, selected, directory, publication))) {
    throw new Error("prepared native request differs from question freeze");
  }
}

export async function replayLongMemEvalSemanticRun(root: string, preparedPath: string) {
  const frozen = readLongMemEvalSemanticFreeze(root);
  const prepared = ExperimentPreparedSchema.parse(readChainArtifact(preparedPath));
  if ((prepared.contract === "longmemeval-native-semantic-prepared-v1") !== (frozen.contract === "longmemeval-native-semantic-v1")) {
    throw new Error("prepared experiment arm differs from freeze");
  }
  if (prepared.freeze_identity !== chainIdentity(frozen)) throw new Error("prepared development run binds another freeze");
  assertLongMemEvalSemanticRows(frozen, prepared.rows);
  const rows: z.infer<typeof LongMemEvalReplaySchema>["rows"] = [];
  for (const row of prepared.rows) {
    if (row.status === "unavailable") { rows.push(row); continue; }
    try {
      const selected = frozen.selected.find((selected) => selected.question_id === row.question_id)!;
      const directory = resolve(root, "questions", String(selected.index).padStart(5, "0"));
      if (row.publication_path !== join(directory, "publication.json")) throw new Error("question publication path changed");
      const publication = verifyLongMemEvalQuestionPublication(frozen, selected, directory, readChainArtifact(row.publication_path));
      if (chainIdentity(publication) !== row.publication_identity) throw new Error("prepared question publication changed");
      verifyLongMemEvalQuestionChain(frozen, selected, directory, publication, row.chain_root);
      const replay = await replaySemanticChain(row.chain_root);
      if (frozen.contract === "longmemeval-semantic-development-v2") LongMemEvalSourceOnlyReplaySchema.parse(replay.result);
      rows.push({ ...row, status: "replayed", replay_path: replay.path });
    } catch (error) { rows.push({ question_id: row.question_id, status: "unavailable", reason: error instanceof Error ? error.message : String(error) }); }
  }
  const result = LongMemEvalExperimentReplaySchema.parse({ contract: frozen.contract === "longmemeval-native-semantic-v1"
    ? "longmemeval-native-semantic-replay-v1" : "longmemeval-semantic-replay-v1", freeze_identity: chainIdentity(frozen),
    prepared_identity: chainIdentity(prepared), provider_calls: 0, rows });
  const path = join(root, `replay-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result); return { path, result };
}
