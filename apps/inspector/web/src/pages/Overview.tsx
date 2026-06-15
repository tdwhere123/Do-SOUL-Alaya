import { useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  CheckSquare,
  FlaskConical,
  Globe2,
  Repeat2,
  RefreshCcw,
  ShieldCheck,
  Zap
} from "lucide-react";
import { apiFetch, getWorkspaceId } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useDaemonHealth } from "../hooks/useDaemonHealth";
import { useI18n } from "../i18n/Locale";
import type { DictKey } from "../i18n/dict";

interface PendingCountEnvelope {
  readonly success: boolean;
  readonly data: { readonly total_count: number };
}

interface BenchSummaryShape {
  readonly latest_slug: string;
  readonly history_count: number;
  readonly payload: {
    readonly bench_name: "self" | "public" | "public-multiturn" | "live";
    readonly split: string;
    readonly run_at: string;
    readonly kpi: { readonly r_at_5: number };
  };
  readonly diff: {
    readonly previous_slug: string | null;
    readonly worst_verdict: "ok" | "warn" | "fail";
    readonly r_at_5_delta_pp: number | null;
  };
}

interface BenchSummaryData {
  readonly self: BenchSummaryShape | null;
  readonly public: BenchSummaryShape | null;
  readonly publicMultiturn: BenchSummaryShape | null;
  readonly live: BenchSummaryShape | null;
}

interface BenchSummaryEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly self: BenchSummaryShape | null;
    readonly public: BenchSummaryShape | null;
    readonly public_multiturn: BenchSummaryShape | null;
    readonly live: BenchSummaryShape | null;
  };
}

interface RecallStatsEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly recall: { readonly total: number };
    readonly usage: { readonly used_ratio: number };
  };
}

interface OverviewQueryData {
  readonly pendingCount: number | null;
  readonly recallStats: {
    readonly total: number;
    readonly usedRatio: number;
  } | null;
  readonly benchData: BenchSummaryData;
  readonly benchLoaded: boolean;
}

const OVERVIEW_RECALL_WINDOW_HOURS = 24 * 7;
const EMPTY_BENCH_DATA: BenchSummaryData = {
  self: null,
  public: null,
  publicMultiturn: null,
  live: null
};

/**
 * OverviewPage condenses daemon readiness, pending proposal count, recall
 * usage, and the latest bench snapshots into the operator's first landing
 * surface.
 */
export default function OverviewPage() {
  const { t } = useI18n();
  const { state, indicator, refresh, refreshing } = useDaemonHealth();
  const workspaceId = getWorkspaceId();

  const fetchOverviewData = useCallback(async (signal: AbortSignal): Promise<OverviewQueryData> => {
    const since = new Date(
      Date.now() - OVERVIEW_RECALL_WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();

    const [pendingResult, recallResult, benchResult] = await Promise.allSettled([
      workspaceId === null
        ? Promise.resolve<PendingCountEnvelope | null>(null)
        : apiFetch<PendingCountEnvelope>(`/proposals/${workspaceId}/pending`, { signal }),
      workspaceId === null
        ? Promise.resolve<RecallStatsEnvelope | null>(null)
        : apiFetch<RecallStatsEnvelope>(
            `/recall-stats/${workspaceId}?since=${encodeURIComponent(since)}`,
            { signal }
          ),
      apiFetch<BenchSummaryEnvelope>("/bench-summary", { signal })
    ]);

    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    return {
      pendingCount:
        pendingResult.status === "fulfilled" && pendingResult.value !== null
          ? pendingResult.value.data.total_count
          : null,
      recallStats:
        recallResult.status === "fulfilled" && recallResult.value !== null
          ? {
              total: recallResult.value.data.recall.total,
              usedRatio: recallResult.value.data.usage.used_ratio
            }
          : null,
      benchData:
        benchResult.status === "fulfilled"
          ? {
              self: benchResult.value.data.self,
              public: benchResult.value.data.public,
              publicMultiturn: benchResult.value.data.public_multiturn,
              live: benchResult.value.data.live
            }
          : EMPTY_BENCH_DATA,
      benchLoaded: true
    };
  }, [workspaceId]);

  const { data: overviewData } = useApiQuery(fetchOverviewData, [workspaceId]);
  const degradedMessage = state.kind === "degraded" ? state.message : null;
  const daemonValue = resolveDaemonLabelKey(state);
  const pendingCount = overviewData?.pendingCount ?? null;
  const recallStats = overviewData?.recallStats ?? null;
  const benchData = overviewData?.benchData ?? EMPTY_BENCH_DATA;
  const benchLoaded = overviewData?.benchLoaded ?? false;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-8 font-mono">
        {degradedMessage ? (
          <div
            role="alert"
            data-testid="overview-degraded"
            className="mb-6 rounded border border-beige-300 bg-beige-200/50 px-4 py-2 font-mono text-xs text-ink-700/80"
          >
            {t("overview:degraded", { message: degradedMessage })}
          </div>
        ) : null}

        <header className="mb-10 flex items-end justify-between gap-6">
          <div>
            <h1 className="mb-2 text-3xl font-bold text-ink-600">{t("overview:title")}</h1>
            <p className="max-w-2xl text-sm text-ink-700/60">{t("overview:subtitle")}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div
              className={`flex items-center gap-2 ${indicator.colorClass}`}
              data-testid="overview-health-indicator"
            >
              <div className="h-2 w-2 animate-pulse rounded-full bg-current" />
              <span className="text-xs font-bold uppercase tracking-wider">
                {indicator.label}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-widest text-ink-700/60 transition-colors hover:text-ink-700 disabled:opacity-50"
              aria-label={t("common:refresh.aria")}
            >
              <RefreshCcw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
              {t("common:refresh")}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryCard
            icon={<Zap className="h-4 w-4" />}
            label={t("overview:card.daemon.label")}
            value={t(daemonValue)}
            subtitle={t("overview:card.daemon.subtitle")}
            link={{ to: "/system?tab=status", text: t("overview:linkStatus") }}
            testId="overview-card-daemon"
          />
          <SummaryCard
            icon={<CheckSquare className="h-4 w-4" />}
            label={t("overview:card.proposals.label")}
            value={pendingCount === null ? "—" : String(pendingCount)}
            subtitle={
              pendingCount === 0
                ? t("overview:card.proposals.empty")
                : t("overview:card.proposals.subtitle")
            }
            link={{ to: "/governance?tab=proposals", text: t("overview:linkProposals") }}
            testId="overview-card-proposals"
          />
          <SummaryCard
            icon={<Activity className="h-4 w-4" />}
            label={t("overview:card.recall.label")}
            value={recallStats === null ? "—" : formatRatio(recallStats.usedRatio)}
            subtitle={
              recallStats === null
                ? t("overview:card.recall.subtitle")
                : t("overview:card.recall.usage", { total: recallStats.total })
            }
            link={{ to: "/recall", text: t("overview:linkRecall") }}
            testId="overview-card-recall"
          />
        </div>

        <section className="mt-10" aria-labelledby="overview-bench-heading">
          <h2
            id="overview-bench-heading"
            className="mb-4 text-sm font-bold uppercase tracking-widest text-ink-600"
          >
            {t("overview:bench.section")}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <BenchCard
              icon={<FlaskConical className="h-4 w-4" />}
              label={t("overview:bench.self.label")}
              hint={t("overview:bench.self.hint")}
              empty={t("overview:bench.empty")}
              summary={benchData.self}
              loaded={benchLoaded}
              t={t}
              testId="overview-bench-self"
            />
            <BenchCard
              icon={<Globe2 className="h-4 w-4" />}
              label={t("overview:bench.public.label")}
              hint={t("overview:bench.public.hint")}
              empty={t("overview:bench.empty")}
              summary={benchData.public}
              loaded={benchLoaded}
              t={t}
              testId="overview-bench-public"
            />
            <BenchCard
              icon={<Repeat2 className="h-4 w-4" />}
              label={t("overview:bench.publicMultiturn.label")}
              hint={t("overview:bench.publicMultiturn.hint")}
              empty={t("overview:bench.empty")}
              summary={benchData.publicMultiturn}
              loaded={benchLoaded}
              t={t}
              testId="overview-bench-public-multiturn"
            />
            <BenchCard
              icon={<ShieldCheck className="h-4 w-4" />}
              label={t("overview:bench.live.label")}
              hint={t("overview:bench.live.hint")}
              empty={t("overview:bench.empty")}
              summary={benchData.live}
              loaded={benchLoaded}
              t={t}
              testId="overview-bench-live"
            />
          </div>
        </section>
      </div>
    </div>
  );
}

interface BenchCardProps {
  readonly empty: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly loaded: boolean;
  readonly summary: BenchSummaryShape | null;
  readonly t: (key: DictKey, params?: Record<string, string | number>) => string;
  readonly testId?: string;
}

function BenchCard({ empty, hint, icon, label, loaded, summary, t, testId }: BenchCardProps) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-3 rounded-lg border border-beige-200 bg-beige-50 p-5"
    >
      <div className="flex items-center gap-2 text-ink-700/40">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-widest">{label}</span>
      </div>
      {summary === null ? (
        <div className="text-[11px] text-ink-700/55" data-testid={`${testId}-empty`}>
          {loaded ? empty : t("overview:bench.loading")}
        </div>
      ) : (
        <>
          <div className="text-3xl font-bold tabular-nums text-ink-600">
            {formatRatio(summary.payload.kpi.r_at_5)}
          </div>
          <div className="text-[11px] text-ink-700/55">
            R@5 ·{" "}
            {summary.diff.r_at_5_delta_pp === null
              ? t("overview:bench.firstBaseline")
              : t("overview:bench.delta", {
                  delta: formatDeltaPp(summary.diff.r_at_5_delta_pp)
                })}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-ink-700/55">
            {summary.payload.split} · {summary.latest_slug}
          </div>
          <div className="text-[10px] text-ink-700/40">
            {t("overview:bench.history", { count: summary.history_count })}
          </div>
        </>
      )}
      <div className="mt-auto text-[10px] text-ink-700/40">{hint}</div>
    </div>
  );
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDeltaPp(deltaPp: number): string {
  if (!Number.isFinite(deltaPp)) return "—";
  if (deltaPp === 0) return "0pp";
  const sign = deltaPp > 0 ? "+" : "";
  return `${sign}${deltaPp.toFixed(1)}pp`;
}

function resolveDaemonLabelKey(
  state: ReturnType<typeof useDaemonHealth>["state"]
): DictKey {
  if (state.kind === "degraded") return "overview:card.daemon.value.warming";
  if (state.kind === "ok" && state.status.daemon.ready) {
    return "overview:card.daemon.value.ready";
  }
  if (state.kind === "ok") return "overview:card.daemon.value.initializing";
  return "overview:card.daemon.value.offline";
}

interface SummaryCardProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly link?: { readonly to: string; readonly text: string };
  readonly subtitle: string;
  readonly testId?: string;
  readonly value: string;
}

function SummaryCard({ icon, label, link, subtitle, testId, value }: SummaryCardProps) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-3 rounded-lg border border-beige-200 bg-beige-50 p-5"
    >
      <div className="flex items-center gap-2 text-ink-700/40">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-widest">{label}</span>
      </div>
      <div className="text-3xl font-bold tabular-nums text-ink-600">{value}</div>
      <div className="text-[11px] text-ink-700/55">{subtitle}</div>
      {link ? (
        <Link
          to={link.to}
          className="mt-auto text-[10px] uppercase tracking-widest text-ink-600 hover:text-ink-700"
        >
          {link.text}
        </Link>
      ) : null}
    </div>
  );
}
