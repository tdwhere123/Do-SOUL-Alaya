import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type VitestFn = ReturnType<typeof vi.fn>;

const locomoRunnerMocks = vi.hoisted<{
  readonly startBenchDaemonMock: VitestFn;
  readonly loadLocomoMock: VitestFn;
}>(() => ({
  startBenchDaemonMock: vi.fn(),
  loadLocomoMock: vi.fn()
}));

const startBenchDaemonMock: VitestFn = locomoRunnerMocks.startBenchDaemonMock;

const loadLocomoMock: VitestFn = locomoRunnerMocks.loadLocomoMock;

vi.mock("../../harness/daemon.js", () => ({
  startBenchDaemon: locomoRunnerMocks.startBenchDaemonMock,
  rotatingSeedObjectKind: () => "fact"
}));

vi.mock("../../locomo/fetch.js", () => ({
  loadLocomo: locomoRunnerMocks.loadLocomoMock
}));

// Bench evidence refs are now <sample>-s<si>-r<ri> (parseable by
// source_proximity). These single-session fixtures use dia_ids d1,d2 in turn
// order, so r<ri> maps to d<ri+1>; fall back to the trailing segment otherwise.
export function benchRefToDiaId(evidenceRef: string): string {
  const match = /-s\d+-r(\d+)/u.exec(evidenceRef);
  if (match !== null) return `d${Number.parseInt(match[1]!, 10) + 1}`;
  return evidenceRef.split("-").at(-1) ?? "unknown";
}

export let tmpDir: string;

export async function writeLocomoArchive(
  historyRoot: string,
  slug: string,
  payload: KpiPayload,
  findingsMarkdown: string | null = null
): Promise<void> {
  const entryRoot = join(historyRoot, "public-locomo", slug);
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

export function buildPriorLocomoPayload(overrides: Partial<KpiPayload> = {}): KpiPayload {
  return {
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: "2026-05-19T10:00:00.000Z",
    alaya_commit: "0000000",
    alaya_version: "0.3.11-test",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: { name: "locomo10", size: 1, source: "fixture" },
    sample_size: 1,
    evaluated_count: 1,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 1,
      r_at_5: 1,
      r_at_10: 1,
      latency_ms_p50: 10,
      latency_ms_p95: 20,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: 1, warm: 0, cold: 0 },
      degradation_reasons: {
        none: 1,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: []
    },
    ...overrides
  };
}

export function buildMockDaemon(overrides: {
  readonly recall?: ReturnType<typeof vi.fn>;
  readonly warmEmbeddingCache?: ReturnType<typeof vi.fn>;
  readonly warmQueryEmbeddingCache?: ReturnType<typeof vi.fn>;
  readonly accrueSessionCoRecall?: ReturnType<typeof vi.fn>;
  readonly runEdgePlanePassIfConfigured?: ReturnType<typeof vi.fn>;
}): Record<string, unknown> {
  const recall = overrides.recall ?? vi.fn(async () => buildRecallResult());
  const warmEmbeddingCache =
    overrides.warmEmbeddingCache ??
    vi.fn(async () => ({
      status: "ready" as const,
      expected_count: 2,
      ready_count: 2,
      ready_rate: 1,
      pass_count: 1,
      missing_object_ids: [],
      provider_kind: "openai",
      model_id: "text-embedding-3-small"
    }));
  const warmQueryEmbeddingCache =
    overrides.warmQueryEmbeddingCache ??
    vi.fn(async (queryTexts: readonly string[]) => ({
      status: "ready" as const,
      requested_count: queryTexts.length,
      ready_count: queryTexts.length,
      cache_hit_count: 0,
      provider_requested_count: queryTexts.length,
      missing_count: 0,
      provider_kind: "openai",
      model_id: "text-embedding-3-small"
    }));
  const proposeMemory = vi.fn(async (_content: string, evidenceRef: string) => {
    const diaId = benchRefToDiaId(evidenceRef);
    return {
      memoryId: `memory-${diaId}`,
      signalId: `signal-${diaId}`,
      proposalId: `proposal-${diaId}`,
      truncated: false,
      charsClipped: 0
    };
  });
  const proposeMemoryFromSignal = vi.fn(async (input: { evidenceRef: string }) => {
    const diaId = benchRefToDiaId(input.evidenceRef);
    return {
      memoryId: `memory-${diaId}`,
      signalId: `signal-${diaId}`,
      proposalId: `proposal-${diaId}`,
      evidenceId: null,
      truncated: false,
      charsClipped: 0
    };
  });
  const proposeMemoriesFromCompileSignals = vi.fn(
    async (inputs: readonly { evidenceRef: string }[]) => ({
      seeds: await Promise.all(
        inputs.map((input) => proposeMemoryFromSignal({ evidenceRef: input.evidenceRef }))
      ),
      dropped: []
    })
  );
  // Stubbed earned co-recall accrual: the LoCoMo seed loop calls it once per
  // session; the fake returns a settled summary (one pair minted) so the runner
  // exercises the call without the real production counter gate.
  // see also: apps/bench-runner/src/harness/co-recall-warmup.ts
  const accrueSessionCoRecall =
    overrides.accrueSessionCoRecall ??
    vi.fn(async () => ({
      pairsObserved: 1,
      minted: 1,
      belowThreshold: 0
    }));
  // Stubbed event-sourced fold: a non-zero full-turn baseline so the harness
  // token-economy contract passes and the kpi carries a real token_economy.
  // see also: apps/bench-runner/src/harness/token-economy.ts deriveBenchTokenMetrics
  const queryTokenMetrics = vi.fn(async () => ({
    raw_history_tokens: 1_000,
    stored_memory_tokens: 200,
    recalled_context_tokens_total: 100,
    recall_event_count: 2,
    recalled_context_tokens_mean: 50,
    seed_event_count: 4
  }));
  const runEdgePlanePassIfConfigured =
    overrides.runEdgePlanePassIfConfigured ?? vi.fn(async () => undefined);
  return {
    proposeMemory,
    warmEmbeddingCache,
    warmQueryEmbeddingCache,
    runEdgePlanePassIfConfigured,
    recall,
    accrueSessionCoRecall,
    queryTokenMetrics,
    attachWorkspace: vi.fn(async (input: { workspaceId: string; runId: string }) => ({
      workspaceId: input.workspaceId,
      runId: input.runId,
      proposeMemory,
      proposeMemoryFromSignal,
      proposeMemoriesFromCompileSignals,
      warmEmbeddingCache,
      warmQueryEmbeddingCache,
      recall,
      accrueSessionCoRecall,
      queryTokenMetrics,
      detach: vi.fn(async () => undefined)
    })),
    shutdown: vi.fn(async () => undefined)
  };
}

export function buildRecallResult(objectId = "memory-d1") {
  return {
    delivery_id: "delivery-1",
    results: [
      {
        object_id: objectId,
        object_kind: "memory_entry",
        relevance_score: 0.9,
        content_preview: objectId,
        evidence_pointers: [objectId],
        selection_reason: "test",
        source_channels: [],
        score_factors: { relevance: 0.9 },
        budget_state: {
          token_estimate: 1,
          max_entries: 10,
          max_total_tokens: 2000,
          remaining_entries: 9,
          remaining_tokens: 1999,
          within_budget: true
        }
      }
    ],
    active_constraints: [],
    active_constraints_count: 0,
    total_count: 1,
    strategy_mix: {
      deterministic_match: true,
      precomputed_rank: true,
      semantic_supplement: true,
      graph_support: false,
      path_plasticity: false,
      global_recall: false
    },
    degradation_reason: null,
    diagnostics: {
      embedding_provider_status: "provider_returned",
      candidates: [
        {
          object_id: objectId,
          final_rank: 1,
          fused_rank: 1,
          fused_score: 1,
          score_factors: { relevance: 0.9 }
        }
      ]
    }
  };
}

beforeEach(async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
  tmpDir = await mkdtemp(join(tmpdir(), "locomo-runner-test-"));
  loadLocomoMock.mockResolvedValue([
    {
      sample_id: "sample-1",
      conversation: {
        speaker_a: "Alice",
        speaker_b: "Bob",
        session_1_date_time: "2026-05-20",
        session_1: [
          { speaker: "Alice", dia_id: "d1", text: "Alice keeps the violin receipt." },
          { speaker: "Bob", dia_id: "d2", text: "Bob talks about weather." }
        ]
      },
      qa: [
        {
          question: "Who keeps the violin receipt?",
          answer: "Alice",
          evidence: ["d1"],
          category: 1
        }
      ]
    }
  ]);
  startBenchDaemonMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

export {
  loadLocomoMock,
  describe,
  expect,
  it,
  startBenchDaemonMock,
  vi
};

export type { KpiPayload };
