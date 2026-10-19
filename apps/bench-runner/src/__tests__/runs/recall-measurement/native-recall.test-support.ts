import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { admitSemanticChainReplay } from "../../../runs/recall-measurement/replay.js";

export const QUESTION = "Which project was mentioned?";
export const HIDDEN_SOURCE = "ARCHIVE_ONLY_PRIVATE_END";
export const HIDDEN_GOLD = "EVALUATOR_ONLY_GOLD";

export async function nativeRecallFixture(sourceText: string | readonly string[] = `Project Aster was mentioned. ${"Other project context. ".repeat(2000)}${HIDDEN_SOURCE}`) {
  const root = mkdtempSync(join(tmpdir(), "native-recall-capture-"));
  const data = join(root, "data"), meta = join(root, "meta"), development = join(root, "development");
  mkdirSync(data); mkdirSync(meta);
  const sources = typeof sourceText === "string" ? [sourceText] : sourceText;
  const sessions = sources.map((_, index) => index === 0 ? "project-session" : `project-session-${index}`);
  const dataset = JSON.stringify([{ question_id: "project", question_type: "fixture", question: QUESTION,
    answer: HIDDEN_GOLD, question_date: "2023/09/13 (Wed) 00:00", haystack_session_ids: sessions,
    haystack_dates: sources.map(() => "2023/09/12 (Tue) 00:00"), answer_session_ids: ["project-session"],
    haystack_sessions: sources.map(content => [{ role: "user", content }]) }]);
  const digest = createHash("sha256").update(dataset).digest("hex");
  writeFileSync(join(data, "longmemeval_s.json"), dataset);
  writeFileSync(join(meta, "longmemeval_s.meta.json"), JSON.stringify({ sha256: digest,
    size_bytes: Buffer.byteLength(dataset), question_count: 1 }));
  await freezeLongMemEvalSemanticRun({ data_dir: data, pinned_meta_root: meta,
    dataset_sha256: digest, dataset_question_count: 1, question_ids: ["project"],
    model: "gemini-2.5-flash-lite", provider_url: "http://127.0.0.1:9", request_profile: "gemini-2.5-nonthinking-v1",
    query_cache_root: join(root, "query-cache"), recorded_at: "2026-09-13T00:00:00.000Z",
    producer_commit: "a".repeat(40), max_output_tokens: 4096, output_byte_limit: 12000,
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000, page_budget: 100000,
      finalization_reserve: 10000, min_envelope: 10 } }, development);
  const prepared = await prepareLongMemEvalSemanticRun(development);
  const replay = await replayLongMemEvalSemanticRun(development, prepared.path);
  const row = replay.result.rows[0]!;
  if (row.status !== "replayed") throw new Error(row.reason);
  const admitted = admitSemanticChainReplay(row.chain_root, row.replay_path);
  return { root, chainRoot: row.chain_root, replayPath: row.replay_path,
    queryKey: admitted.plan.queries[0]!.query_key, admitted };
}
