import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { admitSemanticChainReplay, replaySemanticChain } from "../../../runs/semantic-chain/replay.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { prepareSemanticChainConsumer, type ConsumerConfig } from "../../../runs/semantic-chain/consumer/input.js";
import { pinSemanticChainConsumerAuthority } from "../../../runs/semantic-chain/consumer/authority.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { executeSemanticProposalFill, prepareRetainedSemanticProposalRevision, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { interpretedQueryRaw } from "../../longmemeval/query-producer-fixture.js";
import { syntheticGeminiBody } from "../semantic-proposal/gemini-response-evidence.test-support.js";

export const CONSUMER_CONFIG = { model: STEP_OPENAPI_QUOTE_BASIS.selected_model,
  providerUrl: "https://api.stepfun.com/v1", requestProfile: "step-3.5-2603-low-json-schema-v1" as const,
  apiKey: "loopback-only" };
export const QUESTION = "Which project was mentioned?";
export const HIDDEN_SOURCE = "ARCHIVE_ONLY_PRIVATE_END";
export const HIDDEN_GOLD = "EVALUATOR_ONLY_GOLD";

export async function nativeConsumerFixture(sourceText: string | readonly string[] = `Project Aster was mentioned. ${"Other project context. ".repeat(2000)}${HIDDEN_SOURCE}`) {
  const root = mkdtempSync(join(tmpdir(), "native-task-consumer-"));
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

export async function revisedQueryConsumerFixture(base: Awaited<ReturnType<typeof nativeConsumerFixture>>) {
  const parentRoot = join(base.root, "query-parent"), childRoot = join(base.root, "query-child");
  const parent = base.admitted.plan.config.query_workset, cap = base.admitted.plan.config.max_output_tokens;
  const rawJson = interpretedQueryRaw({ contract: "source-semantic-query-meaning-v5", alternatives: [{ conditions: [{
    kind: "statement", key: "mention", predicate: "mention", arguments: [
      { role: "theme", target: { kind: "free", key: "project", return: true }, excerpt: "Which project" }
    ]
  }] }], gaps: [] });
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const extractor = { extract: async () => ({ rawJson, usage,
    responseMetadata: { finishReason: "STOP" }, responseBody: syntheticGeminiBody(rawJson, "STOP", usage) }) };
  const config = { model: parent.model, providerUrl: parent.provider_url,
    requestProfile: "gemini-2.5-nonthinking-v1" as const, apiKey: "fixture-only" };
  const parentAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(parent, parentRoot, cap, 1),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await executeSemanticProposalFill({ workset: parent, cacheRoot: parentRoot, authority: parentAuthority, config, extractor });
  const revision = prepareRetainedSemanticProposalRevision({ workset: parent, parentCacheRoot: parentRoot,
    maxOutputTokens: cap, itemIndex: 0 });
  const parentItem = parent.items[0];
  if (typeof parentItem !== "object" || parentItem === null) throw new Error("query fixture item must be an object");
  const child = parseSemanticProposalWorkset({ ...parent, revision_parent_cache_root: parentRoot,
    items: [{ ...parentItem, revision }] });
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(child, childRoot, cap, 1),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await executeSemanticProposalFill({ workset: child, cacheRoot: childRoot, authority, config, extractor });
  const chainRoot = join(base.root, "revised-query-chain");
  await prepareSemanticChain({ ...base.admitted.plan.config, query_workset: child, query_cache_root: childRoot }, chainRoot);
  const replay = await replaySemanticChain(chainRoot), admitted = admitSemanticChainReplay(chainRoot, replay.path);
  const parentHistory = () => openSemanticProposalAttemptLedger({ cacheRoot: parentRoot,
    authority: parentAuthority, kind: "query" }).snapshot();
  return { root: base.root, chainRoot, replayPath: replay.path, queryKey: admitted.plan.queries[0]!.query_key,
    admitted, parentRoot, parentKey: parentAuthority.keys[0]!, parentHistory };
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
