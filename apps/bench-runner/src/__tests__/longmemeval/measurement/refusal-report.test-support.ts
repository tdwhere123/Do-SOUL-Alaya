import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { StorageDatabase } from "@do-soul/alaya-storage";
import { SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun, QuestionPublicationSchema } from "../../../runs/longmemeval-semantic/execute.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { inspectSemanticChainReplayTarget } from "../../../runs/recall-measurement/replay.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { sourceLookupStores } from "../../../runs/snapshot/source-records/publish.js";
import { archivedLibraryPages } from "../../runs/recall-measurement/archived-library.test-support.js";
import { fieldLibraryPage } from "../../runs/recall-measurement/field-library.test-support.js";

export const REFUSAL_REPORT_CASES = ["supported", "field-present", "field-null", "missing", "tampered"] as const;
type Case = typeof REFUSAL_REPORT_CASES[number];

/** Freeze and prepare new authored questions against the exact current implementation. All
 * SQLite publications and request identities are real; delivered pages are explicit offline fixtures.
 * No retained natural window or earlier replay identity is modified. */
export async function prepareRefusalReportFixture(cases: readonly Case[] = REFUSAL_REPORT_CASES,
  root = mkdtempSync(join(tmpdir(), "longmemeval-refusal-report-"))) {
  const dataDir = join(root, "data"), metaRoot = join(root, "meta"), experiment = join(root, "experiment");
  mkdirSync(dataDir, { recursive: true }); mkdirSync(metaRoot, { recursive: true });
  const questions = cases.map(id => ({ question_id: id, question_type: "fixture", question: `Where is the stone for ${id}?`,
    answer: "EVALUATOR_ONLY_GOLD", question_date: "2023/09/13 (Wed) 00:00",
    haystack_session_ids: [`${id}-session`], haystack_dates: ["2023/09/12 (Tue) 00:00"],
    // Refused questions deliberately lack a complete gold join. It must never mask their cause.
    answer_session_ids: id.startsWith("field-") ? ["absent-gold-session"] : [`${id}-session`],
    haystack_sessions: [[{ role: "user", content: "The blue stone is in the cedar box.", has_answer: true }]] }));
  const bytes = JSON.stringify(questions), digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(dataDir, "longmemeval_s.json"), bytes);
  writeFileSync(join(metaRoot, "longmemeval_s.meta.json"), JSON.stringify({ sha256: digest,
    size_bytes: Buffer.byteLength(bytes), question_count: questions.length }));
  const frozen = await freezeLongMemEvalSemanticRun({ data_dir: dataDir, pinned_meta_root: metaRoot,
    dataset_sha256: digest, dataset_question_count: questions.length, question_ids: cases,
    model: "gemini-2.5-flash-lite", provider_url: "http://127.0.0.1:9", request_profile: "gemini-2.5-nonthinking-v1",
    query_cache_root: join(root, "unattempted-query-cache"), recorded_at: "2026-09-22T00:00:00.000Z",
    producer_commit: "a".repeat(40), max_output_tokens: 4096, output_byte_limit: 1000000,
    budget: { schema_version: 1, work_units: 10000000, memory_bytes: 60000000, page_budget: 10000,
      finalization_reserve: 50000, min_envelope: 10 }, arm: "native_semantic", workspace_prefix: "refusal-report",
    source_cache_roots: [], correspondence_cache_root: join(root, "unattempted-correspondence-cache"),
    source_publication_associations: [], discovery_page_cap: 1, correspondence_pair_cap: 0,
    authorized_scopes: { mode: "named", scopes: ["project"] } }, experiment);
  const prepared = await prepareLongMemEvalSemanticRun(experiment);
  const rows = prepared.result.rows.map(row => {
    if (row.status !== "prepared") throw new Error(`fixture preparation failed: ${row.reason}`);
    const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(row.chain_root, "prepare.json")));
    const query = plan.queries[0]!;
    if (query.status !== "raw_ready") throw new Error("fixture requires unattempted query semantics");
    const publication = QuestionPublicationSchema.parse(readChainArtifact(row.publication_path));
    const connection = new Database(plan.config.snapshot_path, { readonly: true, fileMustExist: true });
    let sources;
    try {
      connection.pragma("query_only = ON");
      const stores = sourceLookupStores(new StorageDatabase(plan.config.snapshot_path, connection));
      sources = publication.sources.map(source => {
        const stored = stores.getStoredRecord(publication.workspace_id, source.record_id!);
        if (stored === null || stored.content_bytes !== "User: The blue stone is in the cedar box.") throw new Error("sealed fixture source changed");
        return { record: stored.record, text: stored.content_bytes };
      });
    } finally { connection.close(); }
    const source = sources[0]!;
    const page = row.question_id.startsWith("field-")
      ? fieldLibraryPage(source.record, plan.config.budget, plan.config.interpretation_clock, source.text)
      : archivedLibraryPages(plan, sources, `archive-${row.question_id}`).initial;
    const response = row.question_id === "tampered" ? SoulInterpretationResponseSchema.parse({ ...page,
      results: page.results!.map(result => ({ ...result, content_preview: "not the sealed source" })) }) : page;
    if (response.operation !== "recall") throw new Error("fixture recall response required");
    const native = { query_key: query.query_key, status: "replayed",
      ...(row.question_id === "missing" ? {} : { response }),
      first_exposure: row.question_id === "field-null" || row.question_id === "missing" ? null
        : recordSourceSemanticLibraryFirstExposure(response),
      correspondence_outcomes: [], preparation_trace: query.discovery_trace, preparation_elapsed_ms: 2, native_elapsed_ms: 5 };
    const target = inspectSemanticChainReplayTarget(row.chain_root, "retained"), rowPath = target.rowPaths.get(query.query_key)!;
    writeChainArtifact(`${rowPath}.reserved`, { replay_identity: target.identity, query_key: query.query_key });
    writeChainArtifact(rowPath, native);
    writeChainArtifact(target.output, { contract: "source-semantic-chain-replay-v3", plan_identity: chainIdentity(plan),
      identity: target.identity, arm: "retained", provider_calls: 0, rows: [native] });
    return { ...row, status: "replayed", replay_path: target.output };
  });
  const replay = { contract: "longmemeval-native-semantic-replay-v1", freeze_identity: chainIdentity(frozen),
    prepared_identity: chainIdentity(prepared.result), provider_calls: 0, rows };
  const replayPath = join(experiment, `replay-${chainIdentity(replay)}.json`);
  writeChainArtifact(replayPath, replay);
  return { root, experiment, replayPath, replay, frozen, dataDir };
}
