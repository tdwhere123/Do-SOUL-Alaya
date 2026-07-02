import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KpiPayload } from "@do-soul/alaya-eval";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";

export function buildMockQuestion(
  id: string,
  answerSessionId: string
): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `What did the user say about topic ${id}?`,
    answer: `The answer for ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [answerSessionId, "decoy-session"],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: `The correct fact about ${id} is stored here.`, has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ],
      [
        { role: "user", content: "Unrelated conversation about cooking pasta." }
      ]
    ],
    answer_session_ids: [answerSessionId]
  };
}

export function buildLongMemEvalArchivePayload(
  overrides: Partial<KpiPayload> = {}
): KpiPayload {
  return {
    bench_name: "public",
    split: "longmemeval-oracle",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "abc1234",
    alaya_version: "0.3.10-test",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "chat",
    simulate_report: "none",
    dataset: {
      name: "longmemeval_oracle",
      size: 2,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    },
    sample_size: 2,
    evaluated_count: 2,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0,
      r_at_5: 0.5,
      r_at_10: 0.5,
      latency_ms_p50: 10,
      latency_ms_p95: 20,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: 0, warm: 1, cold: 1 },
      degradation_reasons: {
        none: 2,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      seed_extraction_path: {
        path: "official_api_compile",
        cache_hits: 0,
        llm_calls: 1,
        offline_fallbacks: 0,
        live_extraction_failures: 0,
        cached_extraction_failures: 0,
        facts_produced: 5,
        signals_dropped: 0,
        parse_dropped: 0,
        compile_overflow_dropped: 0,
        signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
      },
      per_scenario: [
        { id: "q001", version: 1, hit_at_5: false, tier: "cold" },
        { id: "q002", version: 1, hit_at_5: true, tier: "warm" }
      ]
    },
    ...overrides
  };
}

export async function writeArchiveEntry(
  historyRoot: string,
  benchName: KpiPayload["bench_name"],
  slug: string,
  payload: KpiPayload,
  findingsMarkdown: string | null = null
): Promise<void> {
  const entryRoot = join(historyRoot, benchName, slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(
    join(entryRoot, "kpi.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );
  await writeFile(join(entryRoot, "report.md"), "report\n", "utf8");
  if (findingsMarkdown !== null) {
    await writeFile(join(entryRoot, "findings.md"), findingsMarkdown, "utf8");
  }
}

export function buildRecallResult(
  deliveryId: string,
  objectIds: readonly string[]
) {
  return {
    delivery_id: deliveryId,
    results: objectIds.map((objectId, index) => ({
      object_id: objectId,
      object_kind: "memory_entry",
      relevance_score: 0.9 - index * 0.1,
      content_preview: objectId,
      evidence_pointers: [objectId],
      selection_reason: "test",
      source_channels: [],
      score_factors: { relevance: 0.9 - index * 0.1 },
      budget_state: {
        token_estimate: 1,
        max_entries: 10,
        max_total_tokens: 2000,
        remaining_entries: 9 - index,
        remaining_tokens: 1999 - index,
        within_budget: true
      }
    })),
    total_count: objectIds.length,
    strategy_mix: {
      deterministic_match: true,
      precomputed_rank: true,
      semantic_supplement: false,
      graph_support: false,
      path_plasticity: false,
      global_recall: false
    },
    degradation_reason: null
  };
}
