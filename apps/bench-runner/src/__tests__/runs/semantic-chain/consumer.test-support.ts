import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { admitSemanticChainReplay } from "../../../runs/semantic-chain/replay.js";
import { prepareSemanticChainConsumer, type ConsumerConfig } from "../../../runs/semantic-chain/consumer/input.js";
import { pinSemanticChainConsumerAuthority } from "../../../runs/semantic-chain/consumer/authority.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";

export const CONSUMER_CONFIG = { model: STEP_OPENAPI_QUOTE_BASIS.selected_model,
  providerUrl: "https://api.stepfun.com/v1", requestProfile: "step-3.5-2603-low-json-schema-v1" as const,
  apiKey: "loopback-only" };
export const QUESTION = "Which project was mentioned?";
export const HIDDEN_SOURCE = "ARCHIVE_ONLY_PRIVATE_END";
export const HIDDEN_GOLD = "EVALUATOR_ONLY_GOLD";

export async function nativeConsumerFixture() {
  const root = mkdtempSync(join(tmpdir(), "native-task-consumer-"));
  const data = join(root, "data"), meta = join(root, "meta"), development = join(root, "development");
  mkdirSync(data); mkdirSync(meta);
  const dataset = JSON.stringify([{ question_id: "project", question_type: "fixture", question: QUESTION,
    answer: HIDDEN_GOLD, question_date: "2023/09/13 (Wed) 00:00", haystack_session_ids: ["project-session"],
    haystack_dates: ["2023/09/12 (Tue) 00:00"], answer_session_ids: ["project-session"],
    haystack_sessions: [[{ role: "user", content: `Project Aster was mentioned. ${"Other project context. ".repeat(2000)}${HIDDEN_SOURCE}` }]] }]);
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

export function consumerAuthority(fixture: Awaited<ReturnType<typeof nativeConsumerFixture>>, name: string,
  arms: ConsumerConfig["arms"] = ["native_delivery"]) {
  const preparationRoot = join(fixture.root, name);
  const preparation = prepareSemanticChainConsumer({ chainRoot: fixture.chainRoot, replayPath: fixture.replayPath,
    queryKey: fixture.queryKey, consumerConfig: { model: CONSUMER_CONFIG.model, provider_url: CONSUMER_CONFIG.providerUrl,
      request_profile: CONSUMER_CONFIG.requestProfile, max_output_tokens: 128, arms } }, preparationRoot);
  const authority = pinSemanticChainConsumerAuthority({ preparationRoot,
    inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.42, spendCeilingUsd: 1 });
  return { preparation, authority, root: authority.execution_scope.execution_root_path,
    key: authority.keys[0]!, ledgerPath: join(authority.execution_scope.execution_root_path,
      `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`) };
}
