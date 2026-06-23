import type {
  MemorySearchResult,
  SoulActiveConstraint
} from "@do-soul/alaya-protocol";
import type { SeedObjectKind } from "../harness/daemon.js";

export type ScenarioLabel =
  | "uniform-fact"
  | "rotated-kind"
  | "stress-policy-max10-conflict-true"
  | "chat-policy-max10-conflict-false"
  | "cold-report-context-usage-none"
  | "warm-report-context-usage-mixed";

export interface FixtureSeed {
  readonly id: string;
  readonly content: string;
  readonly distilledFact?: string;
}

export interface FixtureQuestion {
  readonly id: string;
  readonly question: string;
  readonly expectedSeedIds: readonly string[];
}

export interface SeedSidecar {
  readonly fixtureId: string;
  readonly objectKind: SeedObjectKind;
  readonly memoryId: string;
  readonly signalId: string;
  readonly proposalId: string;
}

export interface CandidateDiagnostic {
  readonly object_id: string;
  readonly pre_budget_rank: number | null;
  readonly fused_rank: number | null;
  readonly final_rank: number | null;
  readonly dropped_reason: string | null;
  readonly lexical_rank: number | null;
  readonly fused_rank_contribution_per_stream: Readonly<Record<string, number>>;
  readonly admission_planes: readonly string[];
  readonly source_channels: readonly string[];
}

export interface RecallObservation {
  readonly questionId: string;
  readonly deliveryId: string;
  readonly results: readonly MemorySearchResult[];
  readonly activeConstraints: readonly SoulActiveConstraint[];
  readonly diagnostics: readonly CandidateDiagnostic[];
  readonly expectedObjectIds: readonly string[];
  readonly expectedRank: number | null;
}

export interface ScenarioMetrics {
  readonly rank_distribution: Record<string, number>;
  readonly expected_rank_by_question: Record<string, number | null>;
  readonly hit_at_5: {
    readonly count: number;
    readonly rate: number;
  };
  readonly average_expected_rank: number | null;
  readonly non_monotonic: { readonly count: number };
  readonly active_constraints: { readonly count: number };
  readonly budget_drop: { readonly max_entries: number };
  readonly high_lexical_demoted: { readonly count: number };
  readonly conflict_penalty: { readonly count: number };
  readonly evidence_stream_gold_delivery: {
    readonly count: number;
    readonly denominator: number;
    readonly rate: number;
  };
  readonly path_stream_top10: {
    readonly count: number;
    readonly denominator: number;
    readonly rate: number;
  };
  readonly delivery_count: number;
  readonly diagnostics_count: number;
}

export interface ScenarioArchive {
  readonly label: ScenarioLabel;
  readonly seed_object_kinds: readonly SeedObjectKind[];
  readonly recall_policy: {
    readonly max_entries: number;
    readonly conflict_awareness: boolean;
  };
  readonly report_context_usage: "none" | "mixed";
  readonly pre_report_metrics?: ScenarioMetrics;
  readonly metrics: ScenarioMetrics;
}

export interface NativeHealthGate {
  readonly id:
    | "trust_loop_activation_gain"
    | "evidence_stream_gold_delivery"
    | "path_stream_top10_contribution"
    | "plasticity_gradient_rank_gain";
  readonly label: string;
  readonly current: number | null;
  readonly target: number;
  readonly direction: "min";
  readonly passed: boolean;
  readonly missing: boolean;
}

export interface ControlledReplayArchive {
  readonly schema_version: 1;
  readonly bench_name: "controlled-replay";
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly alaya_version: string;
  readonly recall_pipeline_version: string;
  readonly fixture: {
    readonly seed_count: number;
    readonly question_count: number;
    readonly seed_content_hash: string;
    readonly question_hash: string;
    readonly object_kind_rotation: readonly SeedObjectKind[];
  };
  readonly scenarios: readonly ScenarioArchive[];
  readonly metrics: ScenarioMetrics & {
    readonly cold_warm_delta: Record<string, number | null>;
  };
  readonly native_health_gates: {
    readonly verdict: "ok" | "fail";
    readonly gates: readonly NativeHealthGate[];
  };
  readonly contribution_suspects: readonly {
    readonly label: string;
    readonly score: number;
    readonly evidence: Record<string, number | null>;
  }[];
  readonly evidence: {
    readonly harness_mode: "mcp_propose_review";
    readonly recall_path: "production_recall_service";
    readonly archive_policy: {
      readonly writes_latest_baseline: false;
      readonly writes_kpi_json: false;
    };
    readonly mcp_propose_review: {
      readonly seed_count: number;
      readonly signal_count: number;
      readonly proposal_count: number;
    };
    readonly production_recall: {
      readonly delivery_count: number;
      readonly diagnostics_count: number;
    };
    readonly report_context_usage: {
      readonly mode: "mixed";
      readonly delivery_ids: readonly string[];
    };
  };
}

export interface ControlledReplayRunOptions {
  readonly historyRoot: string;
  readonly runAt?: Date;
  // Override the resolved git SHA so deterministic slugs are testable off-git.
  readonly commitSha?: string;
}

export interface ControlledReplayRunResult {
  readonly slug: string;
  readonly archivePath: string;
  readonly archive: ControlledReplayArchive;
}
