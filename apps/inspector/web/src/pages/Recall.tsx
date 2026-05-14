import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";
import { useI18n } from "../i18n/Locale";
import type { DictKey } from "../i18n/dict";

interface RecallStatsWindow {
  readonly workspace_id: string;
  readonly since: string | null;
  readonly until: string | null;
  readonly excluded_agent_targets: readonly string[];
}

interface RecallStatsRecall {
  readonly total: number;
  readonly unique_sessions: number;
  readonly unique_runs: number;
  readonly null_run: number;
  readonly miss_count: number;
  readonly miss_ratio: number;
  readonly p50_pointer_count: number;
  readonly p50_latency_ms: number;
}

interface RecallStatsUsage {
  readonly total: number;
  readonly used: number;
  readonly skipped: number;
  readonly not_applicable: number;
  readonly used_ratio: number;
  readonly follow_through_ratio: number;
}

interface RecallStats {
  readonly window: RecallStatsWindow;
  readonly recall: RecallStatsRecall;
  readonly usage: RecallStatsUsage;
}

interface RecallStatsEnvelope {
  readonly success: boolean;
  readonly data: RecallStats;
}

type WindowChoice = "24h" | "7d" | "30d";

const WINDOW_LABEL_KEY: Readonly<Record<WindowChoice, DictKey>> = {
  "24h": "recall:window.24h",
  "7d": "recall:window.7d",
  "30d": "recall:window.30d"
};

const WINDOW_HOURS: Readonly<Record<WindowChoice, number>> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30
};

const REFRESH_COOLDOWN_MS = 1_000;

export default function RecallPage() {
  const { t } = useI18n();
  const workspaceId = getWorkspaceId();
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("7d");
  const [stats, setStats] = useState<RecallStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const isMountedRef = useRef(true);
  const refreshLockRef = useRef(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast } = useToasts();

  const since = useMemo(() => {
    const hours = WINDOW_HOURS[windowChoice];
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  }, [windowChoice]);

  const fetchStats = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    try {
      const search = new URLSearchParams();
      search.set("since", since);
      const envelope = await apiFetch<RecallStatsEnvelope>(
        `/recall-stats/${workspaceId}?${search.toString()}`
      );
      if (!isMountedRef.current) return;
      setStats(envelope.data);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      if ((err as ApiError).status === 401) return;
      const message = err instanceof Error ? err.message : "unknown error";
      setError(message);
      showToast({ message: `Recall fetch failed: ${message}`, type: "error" });
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [since, workspaceId, showToast]);

  useEffect(() => {
    isMountedRef.current = true;
    setLoading(true);
    void fetchStats();
    return () => {
      isMountedRef.current = false;
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    };
  }, [fetchStats]);

  const handleRefresh = useCallback(async () => {
    if (refreshLockRef.current) return;
    refreshLockRef.current = true;
    setRefreshing(true);
    await fetchStats();
    if (!isMountedRef.current) {
      refreshLockRef.current = false;
      return;
    }
    cooldownTimerRef.current = setTimeout(() => {
      cooldownTimerRef.current = null;
      refreshLockRef.current = false;
      if (isMountedRef.current) setRefreshing(false);
    }, REFRESH_COOLDOWN_MS);
  }, [fetchStats]);

  if (workspaceId === null) {
    return (
      <div className="h-full w-full overflow-y-auto">
        <div
          role="alert"
          data-testid="recall-no-workspace"
          className="max-w-4xl mx-auto w-full p-8 font-mono text-sm text-ink-700"
        >
          <h1 className="text-2xl font-bold text-ink-600 mb-3 uppercase tracking-widest">
            {t("common:noWorkspace")}
          </h1>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-5xl mx-auto w-full p-8 font-mono">
        <header className="mb-10 flex items-end justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-ink-600 mb-2">
              {t("recall:title")}
            </h1>
            <p className="text-ink-700/60 text-sm max-w-2xl">
              {t("recall:subtitle")}
            </p>
          </div>
          <div className="flex items-end gap-3">
            <WindowToggle choice={windowChoice} onChoose={setWindowChoice} t={t} />
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-widest text-ink-700/60 hover:text-ink-700 disabled:opacity-50 transition-colors"
              aria-label={t("common:refresh.aria")}
            >
              <RefreshCcw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
              {t("common:refresh")}
            </button>
          </div>
        </header>

        {loading && stats === null ? (
          <p
            data-testid="recall-loading"
            className="text-ink-700/60 text-sm font-mono"
          >
            {t("recall:loading")}
          </p>
        ) : null}

        {error !== null && stats === null ? (
          <p
            data-testid="recall-error"
            className="text-state-error-text font-mono text-sm"
          >
            {t("recall:error", { message: error })}
          </p>
        ) : null}

        {stats !== null ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
              <KpiCard
                testId="recall-kpi-total"
                label={t("recall:kpi.total")}
                value={String(stats.recall.total)}
              />
              <KpiCard
                testId="recall-kpi-sessions"
                label={t("recall:kpi.sessions")}
                value={String(stats.recall.unique_sessions)}
              />
              <KpiCard
                testId="recall-kpi-runs"
                label={t("recall:kpi.runs")}
                value={String(stats.recall.unique_runs)}
              />
              <KpiCard
                testId="recall-kpi-miss"
                label={t("recall:kpi.miss")}
                value={formatRatio(stats.recall.miss_ratio)}
              />
              <KpiCard
                testId="recall-kpi-used"
                label={t("recall:kpi.used")}
                value={formatRatio(stats.usage.used_ratio)}
              />
              <KpiCard
                testId="recall-kpi-follow"
                label={t("recall:kpi.follow")}
                value={formatRatio(stats.usage.follow_through_ratio)}
              />
            </div>

            <section className="mb-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <DetailRow
                label={t("recall:detail.p50Pointer")}
                value={String(stats.recall.p50_pointer_count)}
              />
              <DetailRow
                label={t("recall:detail.p50Latency")}
                value={`${stats.recall.p50_latency_ms} ms`}
              />
              <DetailRow
                label={t("recall:detail.nullRun")}
                value={String(stats.recall.null_run)}
              />
              <DetailRow
                label={t("recall:detail.usageTotal")}
                value={`${stats.usage.used} / ${stats.usage.skipped} / ${stats.usage.not_applicable}`}
                hint={t("recall:detail.usageHint")}
              />
            </section>

            <section
              data-testid="recall-window-meta"
              className="text-[10px] font-mono uppercase tracking-widest text-ink-700/55"
            >
              {t("recall:meta.window", {
                since: stats.window.since ?? "—",
                until: stats.window.until ?? t("recall:meta.now")
              })}
              {stats.window.excluded_agent_targets.length > 0 ? (
                <>
                  {" · "}
                  {t("recall:meta.excludedTargets", {
                    targets: stats.window.excluded_agent_targets.join(", ")
                  })}
                </>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface WindowToggleProps {
  readonly choice: WindowChoice;
  readonly onChoose: (next: WindowChoice) => void;
  readonly t: (key: DictKey) => string;
}

function WindowToggle({ choice, onChoose, t }: WindowToggleProps) {
  const choices: ReadonlyArray<WindowChoice> = ["24h", "7d", "30d"];
  return (
    <div
      role="group"
      aria-label="Recall window"
      data-testid="recall-window-toggle"
      className="flex items-center gap-1 rounded-full border border-beige-300 bg-beige-50 p-0.5 shadow-sm"
    >
      {choices.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChoose(value)}
          aria-pressed={choice === value}
          className={
            "px-2 py-0.5 rounded-full text-[10px] font-mono uppercase transition-colors " +
            (choice === value
              ? "bg-ink-600 text-beige-50"
              : "text-ink-700/60 hover:text-ink-700")
          }
        >
          {t(WINDOW_LABEL_KEY[value])}
        </button>
      ))}
    </div>
  );
}

interface KpiCardProps {
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
}

function KpiCard({ label, value, testId }: KpiCardProps) {
  return (
    <div
      data-testid={testId}
      className="p-4 bg-beige-50 border border-beige-200 rounded-lg flex flex-col gap-2"
    >
      <span className="text-[10px] uppercase tracking-widest font-bold text-ink-700/40">
        {label}
      </span>
      <span className="text-2xl font-bold text-ink-600 tabular-nums">
        {value}
      </span>
    </div>
  );
}

interface DetailRowProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

function DetailRow({ label, value, hint }: DetailRowProps) {
  return (
    <div className="p-4 bg-beige-50/70 border border-beige-200 rounded flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest font-bold text-ink-700/40">
        {label}
      </span>
      <span className="text-base text-ink-600 font-mono tabular-nums">
        {value}
      </span>
      {hint !== undefined ? (
        <span className="text-[10px] text-ink-700/40">{hint}</span>
      ) : null}
    </div>
  );
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}
