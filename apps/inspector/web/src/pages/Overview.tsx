import { useEffect, useState, type ReactNode } from "react";
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
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
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

const OVERVIEW_RECALL_WINDOW_HOURS = 24 * 7;

export default function OverviewPage() {
  const { t } = useI18n();
  const { state, indicator, refresh, refreshing } = useDaemonHealth();
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [recallStats, setRecallStats] = useState<{
    readonly total: number;
    readonly usedRatio: number;
  } | null>(null);
  const [benchSelf, setBenchSelf] = useState<BenchSummaryShape | null>(null);
  const [benchPublic, setBenchPublic] = useState<BenchSummaryShape | null>(null);
  const [benchPublicMultiturn, setBenchPublicMultiturn] =
    useState<BenchSummaryShape | null>(null);
  const [benchLive, setBenchLive] = useState<BenchSummaryShape | null>(null);
  const [benchLoaded, setBenchLoaded] = useState(false);
  const workspaceId = getWorkspaceId();

  useEffect(() => {
    if (workspaceId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const envelope = await apiFetch<PendingCountEnvelope>(
          `/proposals/${workspaceId}/pending`
        );
        if (cancelled) return;
        setPendingCount(envelope.data.total_count);
      } catch (err) {
        if (cancelled) return;
        if ((err as ApiError).status === 401) return;
        setPendingCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const since = new Date(
          Date.now() - OVERVIEW_RECALL_WINDOW_HOURS * 60 * 60 * 1000
        ).toISOString();
        const envelope = await apiFetch<RecallStatsEnvelope>(
          `/recall-stats/${workspaceId}?since=${encodeURIComponent(since)}`
        );
        if (cancelled) return;
        setRecallStats({
          total: envelope.data.recall.total,
          usedRatio: envelope.data.usage.used_ratio
        });
      } catch (err) {
        if (cancelled) return;
        if ((err as ApiError).status === 401) return;
        setRecallStats(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const envelope = await apiFetch<BenchSummaryEnvelope>("/bench-summary");
        if (cancelled) return;
        setBenchSelf(envelope.data.self);
        setBenchPublic(envelope.data.public);
        setBenchPublicMultiturn(envelope.data.public_multiturn);
        setBenchLive(envelope.data.live);
      } catch (err) {
        if (cancelled) return;
        if ((err as ApiError).status === 401) return;
        setBenchSelf(null);
        setBenchPublic(null);
        setBenchPublicMultiturn(null);
        setBenchLive(null);
      } finally {
        if (!cancelled) setBenchLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const degradedMessage = state.kind === "degraded" ? state.message : null;
  const daemonValue = resolveDaemonLabelKey(state);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-5xl mx-auto w-full p-8 font-mono">
        {degradedMessage ? (
          <div
            role="alert"
            data-testid="overview-degraded"
            className="mb-6 px-4 py-2 bg-beige-200/50 border border-beige-300 rounded text-xs text-ink-700/80 font-mono"
          >
            {t("overview:degraded", { message: degradedMessage })}
          </div>
        ) : null}

        <header className="mb-10 flex items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl font-bold text-ink-600 mb-2">
              {t("overview:title")}
            </h1>
            <p className="text-ink-700/60 text-sm max-w-2xl">
              {t("overview:subtitle")}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div
              className={`flex items-center gap-2 ${indicator.colorClass}`}
              data-testid="overview-health-indicator"
            >
              <div className="w-2 h-2 rounded-full bg-current animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider">
                {indicator.label}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-widest text-ink-700/60 hover:text-ink-700 disabled:opacity-50 transition-colors"
              aria-label={t("common:refresh.aria")}
            >
              <RefreshCcw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
              {t("common:refresh")}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard
            icon={<Zap className="w-4 h-4" />}
            label={t("overview:card.daemon.label")}
            value={t(daemonValue)}
            subtitle={t("overview:card.daemon.subtitle")}
            link={{ to: "/system?tab=status", text: t("overview:linkStatus") }}
            testId="overview-card-daemon"
          />
          <SummaryCard
            icon={<CheckSquare className="w-4 h-4" />}
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
            icon={<Activity className="w-4 h-4" />}
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
            className="text-sm font-bold text-ink-600 uppercase tracking-widest mb-4"
          >
            {t("overview:bench.section")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <BenchCard
              icon={<FlaskConical className="w-4 h-4" />}
              label={t("overview:bench.self.label")}
              hint={t("overview:bench.self.hint")}
              empty={t("overview:bench.empty")}
              summary={benchSelf}
              loaded={benchLoaded}
              t={t}
              testId="overview-bench-self"
            />
            <BenchCard
              icon={<Globe2 className="w-4 h-4" />}
              label={t("overview:bench.public.label")}
              hint={t("overview:bench.public.hint")}
              empty={t("overview:bench.empty")}
              summary={benchPublic}
              loaded={benchLoaded}
              t={t}
              testId="overview-bench-public"
            />
            <BenchCard
              icon={<Repeat2 className="w-4 h-4" />}
              label={t("overview:bench.publicMultiturn.label")}
              hint={t("overview:bench.publicMultiturn.hint")}
              empty={t("overview:bench.empty")}
              summary={benchPublicMultiturn}
              loaded={benchLoaded}
              t={t}
              testId="overview-bench-public-multiturn"
            />
            <BenchCard
              icon={<ShieldCheck className="w-4 h-4" />}
              label={t("overview:bench.live.label")}
              hint={t("overview:bench.live.hint")}
              empty={t("overview:bench.empty")}
              summary={benchLive}
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
  readonly icon: ReactNode;
  readonly label: string;
  readonly hint: string;
  readonly empty: string;
  readonly summary: BenchSummaryShape | null;
  readonly loaded: boolean;
  readonly t: (key: DictKey, params?: Record<string, string | number>) => string;
  readonly testId?: string;
}

function BenchCard({
  icon,
  label,
  hint,
  empty,
  summary,
  loaded,
  t,
  testId
}: BenchCardProps) {
  return (
    <div
      data-testid={testId}
      className="p-5 bg-beige-50 border border-beige-200 rounded-lg flex flex-col gap-3"
    >
      <div className="flex items-center gap-2 text-ink-700/40">
        {icon}
        <span className="text-[10px] uppercase tracking-widest font-bold">
          {label}
        </span>
      </div>
      {summary === null ? (
        <div className="text-[11px] text-ink-700/55" data-testid={`${testId}-empty`}>
          {loaded ? empty : t("overview:bench.loading")}
        </div>
      ) : (
        <>
          <div className="text-3xl font-bold text-ink-600 tabular-nums">
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
      <div className="text-[10px] text-ink-700/40 mt-auto">{hint}</div>
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
  if (state.kind === "ok" && state.status.daemon.ready)
    return "overview:card.daemon.value.ready";
  if (state.kind === "ok") return "overview:card.daemon.value.initializing";
  return "overview:card.daemon.value.offline";
}

interface SummaryCardProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly subtitle: string;
  readonly link?: { readonly to: string; readonly text: string };
  readonly testId?: string;
}

function SummaryCard({ icon, label, value, subtitle, link, testId }: SummaryCardProps) {
  return (
    <div
      data-testid={testId}
      className="p-5 bg-beige-50 border border-beige-200 rounded-lg flex flex-col gap-3"
    >
      <div className="flex items-center gap-2 text-ink-700/40">
        {icon}
        <span className="text-[10px] uppercase tracking-widest font-bold">
          {label}
        </span>
      </div>
      <div className="text-3xl font-bold text-ink-600 tabular-nums">{value}</div>
      <div className="text-[11px] text-ink-700/55">{subtitle}</div>
      {link ? (
        <Link
          to={link.to}
          className="text-[10px] uppercase tracking-widest text-ink-600 hover:text-ink-700 mt-auto"
        >
          {link.text}
        </Link>
      ) : null}
    </div>
  );
}
