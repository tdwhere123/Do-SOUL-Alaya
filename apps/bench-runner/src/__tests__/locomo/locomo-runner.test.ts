import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as compileSeedModule from "../../longmemeval/compile-seed.js";
import { LocomoSampleSchema } from "../../locomo/dataset.js";

const startBenchDaemonMock = vi.hoisted(() => vi.fn());
const loadLocomoMock = vi.hoisted(() => vi.fn());

vi.mock("../../harness/daemon.js", () => ({
  startBenchDaemon: startBenchDaemonMock,
  rotatingSeedObjectKind: () => "fact"
}));

vi.mock("../../locomo/fetch.js", () => ({
  loadLocomo: loadLocomoMock
}));

import { runLocomo } from "../../locomo/runner.js";

let tmpDir: string;

beforeEach(async () => {
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
  await rm(tmpDir, { recursive: true, force: true });
});

describe("LoCoMo runner", () => {
  it("maps multi-fact extracted seeds back to the source dia_id for scoring", async () => {
    const createCompileSeedRunnerSpy = vi
      .spyOn(compileSeedModule, "createCompileSeedRunner")
      .mockReturnValue({
        stats: {
          path: "official_api_compile",
          cacheHits: 0,
          llmCalls: 1,
          offlineFallbacks: 0,
          liveExtractionFailures: 0,
          cachedExtractionFailures: 0,
          factsProduced: 3,
          signalsDropped: 0,
          signalsDroppedByReason: {
            candidate_absent: 0,
            materialization_error: 0
          },
          parseDropped: 0,
          compileOverflowDropped: 0,
          lastTurnRawSignalCount: 0,
          lastTurnDraftCount: 0,
          lastExtractionSource: null,
          lastCacheKey: null
        },
        seedTurn: vi.fn(async ({ evidenceRefBase }: { evidenceRefBase: string }) => {
          if (evidenceRefBase.endsWith("-d1")) {
            return {
              seeds: [
                {
                  memoryId: "memory-d1-a",
                  signalId: "signal-d1-a",
                  proposalId: "proposal-d1-a",
                  evidenceId: null,
                  truncated: false,
                  charsClipped: 0
                },
                {
                  memoryId: "memory-d1-b",
                  signalId: "signal-d1-b",
                  proposalId: "proposal-d1-b",
                  evidenceId: null,
                  truncated: false,
                  charsClipped: 0
                }
              ],
              turnTruncated: false,
              charsClipped: 0
            };
          }
          return {
            seeds: [
              {
                memoryId: "memory-d2",
                signalId: "signal-d2",
                proposalId: "proposal-d2",
                evidenceId: null,
                truncated: false,
                charsClipped: 0
              }
            ],
            turnTruncated: false,
            charsClipped: 0
          };
        })
      } as ReturnType<typeof compileSeedModule.createCompileSeedRunner>);
    const warmEmbeddingCache = vi.fn(async () => ({
      status: "ready" as const,
      expected_count: 3,
      ready_count: 3,
      ready_rate: 1,
      pass_count: 1,
      missing_object_ids: [],
      provider_kind: "openai",
      model_id: "text-embedding-3-small"
    }));
    const recall = vi.fn(async () => buildRecallResult("memory-d1-b"));
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ recall, warmEmbeddingCache })
    );

    try {
      const result = await runLocomo({
        variant: "locomo10",
        historyRoot: tmpDir,
        embeddingMode: "env"
      });
      expect(result.payload.kpi.r_at_5).toBe(1);
      expect(warmEmbeddingCache).toHaveBeenCalledWith([
        "memory-d1-a",
        "memory-d1-b",
        "memory-d2"
      ]);
    } finally {
      createCompileSeedRunnerSpy.mockRestore();
    }
  });

  it("normalizes semicolon-joined gold evidence before recall scoring", async () => {
    loadLocomoMock.mockResolvedValue([
      LocomoSampleSchema.parse({
        sample_id: "sample-1",
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "2026-05-20",
          session_1: [
            { speaker: "Alice", dia_id: "d1", text: "Alice keeps the violin receipt." },
            { speaker: "Bob", dia_id: "d2", text: "Bob stores the sunset painting." }
          ]
        },
        qa: [
          {
            question: "What painting was stored?",
            answer: "sunset",
            evidence: ["d1; d2"],
            category: 3
          }
        ]
      })
    ]);
    const recall = vi.fn(async () => buildRecallResult("memory-d2"));
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir
    });

    expect(result.payload.sample_size).toBe(1);
    expect(result.payload.evaluated_count).toBe(1);
    expect(result.payload.kpi.r_at_5).toBe(1);
    expect(recall).toHaveBeenCalledTimes(1);
  });

  it("fails closed before scoring when embedding warm cache is incomplete", async () => {
    const recall = vi.fn();
    const warmEmbeddingCache = vi.fn(async () => {
      throw new Error("embedding warm cache not ready after 1 pass(es)");
    });
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ recall, warmEmbeddingCache })
    );

    await expect(
      runLocomo({
        variant: "locomo10",
        historyRoot: tmpDir,
        embeddingMode: "env"
      })
    ).rejects.toThrow("embedding warm cache not ready");

    expect(warmEmbeddingCache).toHaveBeenCalledWith(["memory-d1", "memory-d2"]);
    expect(recall).not.toHaveBeenCalled();
  });

  it("archives embedding warm-cache readiness for env LoCoMo runs", async () => {
    const warmEmbeddingCache = vi.fn(async () => ({
      status: "ready" as const,
      expected_count: 2,
      ready_count: 2,
      ready_rate: 1,
      pass_count: 1,
      missing_object_ids: [],
      provider_kind: "openai",
      model_id: "text-embedding-3-small"
    }));
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ warmEmbeddingCache })
    );

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      embeddingMode: "env"
    });
    const kpi = JSON.parse(await readFile(result.kpiPath, "utf8")) as {
      readonly kpi: {
        readonly provider_returned_rate?: number;
        readonly embedding_vector_cache_ready_rate?: number;
        readonly query_embedding_cache_ready_rate?: number;
      };
    };
    const diagnostics = JSON.parse(await readFile(result.diagnosticsPath, "utf8")) as {
      readonly embedding_vector_cache?: {
        readonly expected_count: number;
        readonly ready_count: number;
        readonly ready_rate: number;
      };
      readonly query_embedding_cache?: {
        readonly requested_count: number;
        readonly ready_count: number;
        readonly ready_rate: number;
      };
    };

    expect(kpi.kpi.provider_returned_rate).toBe(1);
    expect(kpi.kpi.embedding_vector_cache_ready_rate).toBe(1);
    expect(kpi.kpi.query_embedding_cache_ready_rate).toBe(1);
    expect(diagnostics.embedding_vector_cache).toEqual(
      expect.objectContaining({
        expected_count: 2,
        ready_count: 2,
        ready_rate: 1
      })
    );
    expect(diagnostics.query_embedding_cache).toEqual(
      expect.objectContaining({
        requested_count: 1,
        ready_count: 1,
        ready_rate: 1
      })
    );
  });

  it("archives partial query warm-cache readiness without aborting scoring", async () => {
    const warmQueryEmbeddingCache = vi.fn(async (queryTexts: readonly string[]) => ({
      status: "ready" as const,
      requested_count: queryTexts.length,
      ready_count: 0,
      cache_hit_count: 0,
      provider_requested_count: queryTexts.length,
      missing_count: queryTexts.length,
      provider_kind: "openai",
      model_id: "text-embedding-3-small",
      last_error: "provider temporarily unreachable"
    }));
    const recall = vi.fn(async () => buildRecallResult());
    const accrueSessionCoRecall = vi.fn(async () => ({
      pairsObserved: 1,
      minted: 1,
      belowThreshold: 0
    }));
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ recall, warmQueryEmbeddingCache, accrueSessionCoRecall })
    );

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      embeddingMode: "env"
    });
    // The LoCoMo seed loop drives the EARNED co-recall accrual once per session.
    expect(accrueSessionCoRecall).toHaveBeenCalled();
    const kpi = JSON.parse(await readFile(result.kpiPath, "utf8")) as {
      readonly kpi: {
        readonly query_embedding_cache_ready_rate?: number;
      };
    };
    const diagnostics = JSON.parse(await readFile(result.diagnosticsPath, "utf8")) as {
      readonly query_embedding_cache?: {
        readonly requested_count: number;
        readonly ready_count: number;
        readonly ready_rate: number;
        readonly last_error?: string;
      };
    };

    expect(recall).toHaveBeenCalledTimes(1);
    expect(kpi.kpi.query_embedding_cache_ready_rate).toBe(0);
    expect(diagnostics.query_embedding_cache).toEqual(
      expect.objectContaining({
        requested_count: 1,
        ready_count: 0,
        ready_rate: 0,
        last_error: "provider temporarily unreachable"
      })
    );
  });

  it("keeps answerless adversarial rows in the retrieval denominator while still using the abstention QA judge", async () => {
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
          },
          {
            question: "What is Alice's PIN?",
            answer: "",
            evidence: ["d2"],
            category: 5
          }
        ]
      }
    ]);
    const replies = ["Alice", "yes", "I don't know.", "yes"];
    const qaChat = vi.fn(async () => replies.shift() ?? "yes");
    const recall = vi
      .fn()
      .mockImplementationOnce(async () => buildRecallResult("memory-d1"))
      .mockImplementationOnce(async () => buildRecallResult("memory-d2"));
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      qa: { chat: qaChat }
    });

    expect(result.payload.sample_size).toBe(2);
    expect(result.payload.evaluated_count).toBe(2);
    expect(result.payload.kpi.r_at_5).toBe(1);
    expect(qaChat).toHaveBeenCalledTimes(4);
    const abstentionJudgeUser =
      ((qaChat.mock.calls[3] as unknown as string[] | undefined)?.[1] ?? "");
    expect(abstentionJudgeUser).toContain("Explanation:");
  });

  it("keeps category-5 rows with an explicit gold answer scoreable as factual QA", async () => {
    loadLocomoMock.mockResolvedValue([
      {
        sample_id: "sample-1",
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "2026-05-20",
          session_1: [
            { speaker: "Alice", dia_id: "d1", text: "Alice owns a cat named Oscar." },
            { speaker: "Bob", dia_id: "d2", text: "Oscar belongs to Alice, not Melanie." }
          ]
        },
        qa: [
          {
            question: "Is Oscar Melanie's pet?",
            answer: "No",
            adversarial_answer: "Yes",
            evidence: ["d2"],
            category: 5
          }
        ]
      }
    ]);
    const qaChat = vi.fn(async (system: string, user: string) => {
      if (user.includes("Correct Answer:")) return "yes";
      if (system.includes("strict grader")) return "yes";
      return "No";
    });
    const recall = vi.fn(async () => buildRecallResult("memory-d2"));
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      qa: { chat: qaChat }
    });

    expect(result.payload.sample_size).toBe(1);
    expect(result.payload.evaluated_count).toBe(1);
    expect(result.payload.kpi.r_at_5).toBe(1);
    expect(qaChat).toHaveBeenCalledTimes(2);
    const factualJudgeUser =
      ((qaChat.mock.calls[1] as unknown as string[] | undefined)?.[1] ?? "");
    expect(factualJudgeUser).toContain("Correct Answer: No");
    expect(factualJudgeUser).not.toContain("Explanation:");
  });

  it("routes category-3 LoCoMo QA through the aggregation answer prompt", async () => {
    loadLocomoMock.mockResolvedValue([
      {
        sample_id: "sample-1",
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "2026-05-20",
          session_1: [
            { speaker: "Alice", dia_id: "d1", text: "Alice planned a mural project." },
            { speaker: "Bob", dia_id: "d2", text: "Bob mentioned a violin project." }
          ]
        },
        qa: [
          {
            question: "How many projects were mentioned?",
            answer: "2",
            evidence: ["d1", "d2"],
            category: 3
          }
        ]
      }
    ]);
    const qaChat = vi.fn(async (system: string) => {
      if (system.includes("strict grader")) return "yes";
      return "2";
    });
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({}));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      qa: { chat: qaChat }
    });

    expect(result.payload.sample_size).toBe(1);
    expect(result.payload.evaluated_count).toBe(1);
    expect(result.payload.kpi.r_at_5).toBe(1);
    const aggregationAnswerSystem =
      ((qaChat.mock.calls[0] as unknown as string[] | undefined)?.[0] ?? "");
    expect(aggregationAnswerSystem).toContain("aggregate across the whole history");
  });

  it("fails closed when a scored gold dia_id materializes to zero memory ids", async () => {
    const createCompileSeedRunnerSpy = vi
      .spyOn(compileSeedModule, "createCompileSeedRunner")
      .mockReturnValue({
        stats: {
          path: "official_api_compile",
          cacheHits: 0,
          llmCalls: 1,
          offlineFallbacks: 0,
          liveExtractionFailures: 0,
          cachedExtractionFailures: 0,
          factsProduced: 2,
          signalsDropped: 1,
          signalsDroppedByReason: {
            candidate_absent: 1,
            materialization_error: 0
          },
          parseDropped: 0,
          compileOverflowDropped: 0,
          lastTurnRawSignalCount: 0,
          lastTurnDraftCount: 0,
          lastExtractionSource: null,
          lastCacheKey: null
        },
        seedTurn: vi.fn(async ({ evidenceRefBase }: { evidenceRefBase: string }) => {
          if (evidenceRefBase.endsWith("-d1")) {
            return { seeds: [], turnTruncated: false, charsClipped: 0 };
          }
          return {
            seeds: [
              {
                memoryId: "memory-d2",
                signalId: "signal-d2",
                proposalId: "proposal-d2",
                evidenceId: null,
                truncated: false,
                charsClipped: 0
              }
            ],
            turnTruncated: false,
            charsClipped: 0
          };
        })
      } as ReturnType<typeof compileSeedModule.createCompileSeedRunner>);
    const recall = vi.fn(async () => buildRecallResult());
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    try {
      await expect(
        runLocomo({
          variant: "locomo10",
          historyRoot: tmpDir
        })
      ).rejects.toThrow("LoCoMo seed materialization lost gold evidence");
      expect(recall).not.toHaveBeenCalled();
    } finally {
      createCompileSeedRunnerSpy.mockRestore();
    }
  });

  it("archives the seed-extraction path and blocker text on the LoCoMo surface", async () => {
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({}));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir
    });
    const kpi = JSON.parse(await readFile(result.kpiPath, "utf8")) as KpiPayload;
    const report = await readFile(result.reportPath, "utf8");
    const findings = await readFile(result.findingsPath, "utf8");

    expect(kpi.kpi.seed_extraction_path).toMatchObject({
      path: "no_credentials_fallback",
      offline_fallbacks: 2
    });
    expect(report).toContain("seed_extraction_path no_credentials_fallback");
    expect(findings).toContain("seed_extraction_path no_credentials_fallback");
  });

  it("diffs public-locomo runs against the newest passing baseline", async () => {
    const priorPassingRunAt = "2026-05-19T12:00:00.000Z";
    await writeLocomoArchive(
      tmpDir,
      "2026-05-19T120000Z-aaa1111",
      buildPriorLocomoPayload({
        run_at: priorPassingRunAt,
        alaya_commit: "aaa1111"
      })
    );
    await writeLocomoArchive(
      tmpDir,
      "2026-05-19T130000Z-bbb2222",
      buildPriorLocomoPayload({
        run_at: "2026-05-19T13:00:00.000Z",
        alaya_commit: "bbb2222"
      }),
      "# findings\n- regression\n"
    );
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({}));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir
    });

    expect(result.payload.diff_vs_previous?.previous_run).toBe(priorPassingRunAt);
  });
});

async function writeLocomoArchive(
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

function buildPriorLocomoPayload(overrides: Partial<KpiPayload> = {}): KpiPayload {
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

function buildMockDaemon(overrides: {
  readonly recall?: ReturnType<typeof vi.fn>;
  readonly warmEmbeddingCache?: ReturnType<typeof vi.fn>;
  readonly warmQueryEmbeddingCache?: ReturnType<typeof vi.fn>;
  readonly accrueSessionCoRecall?: ReturnType<typeof vi.fn>;
}) {
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
    const diaId = evidenceRef.split("-").at(-1) ?? "unknown";
    return {
      memoryId: `memory-${diaId}`,
      signalId: `signal-${diaId}`,
      proposalId: `proposal-${diaId}`,
      truncated: false,
      charsClipped: 0
    };
  });
  const proposeMemoryFromSignal = vi.fn(async (input: { evidenceRef: string }) => {
    const diaId = input.evidenceRef.split("-").at(-1) ?? "unknown";
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
  return {
    proposeMemory,
    warmEmbeddingCache,
    warmQueryEmbeddingCache,
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

function buildRecallResult(objectId = "memory-d1") {
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
