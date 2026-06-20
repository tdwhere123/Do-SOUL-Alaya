import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { apiFetch, getWorkspaceId } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
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
  readonly miss_ratio: number;
  readonly p50_pointer_count: number;
  readonly p50_latency_ms: number;
}

interface RecallStatsUsage {
  readonly used: number;
  readonly skipped: number;
  readonly not_applicable: number;
  readonly used_ratio: number;
  readonly follow_through_ratio: number;
}

interface RecallStatsEmbedding {
  readonly total_queries: number;
  readonly returned_candidate_count: number;
  readonly p50_latency_ms: number;
  readonly p95_latency_ms: number;
  readonly p99_latency_ms: number;
  readonly latency_buckets: readonly Readonly<{ readonly label: string; readonly count: number }>[];
}

interface RecallStats {
  readonly window: RecallStatsWindow;
  readonly recall: RecallStatsRecall;
  readonly embedding: RecallStatsEmbedding;
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
  const controller = useRecallController();
  if (controller.workspaceId === null) {
    return <RecallNoWorkspace title={controller.t("common:noWorkspace")} />;
  }
  return <RecallPageView controller={controller} />;
}

function useRecallController() {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId();
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("7d");
  const [refreshing, setRefreshing] = useState(false);
  const refreshState = useRefreshCooldown(setRefreshing);
  const fetchStats = useCallback(
    (signal: AbortSignal) => fetchRecallStats(workspaceId, windowChoice, signal),
    [windowChoice, workspaceId]
  );
  const query = useApiQuery(fetchStats, [workspaceId, windowChoice], {
    enabled: workspaceId !== null,
    onError: (message) => showToast({ message: `Recall fetch failed: ${message}`, type: "error" })
  });
  const handleRefresh = useCallback(
    () => refreshRecall(query.refetch, refreshState, setRefreshing),
    [query.refetch, refreshState]
  );
  return { ...query, handleRefresh, refreshing, setWindowChoice, t, windowChoice, workspaceId };
}

function useRefreshCooldown(setRefreshing: (value: boolean) => void) {
  const refreshLockRef = useRef(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    };
  }, []);
  return { cooldownTimerRef, refreshLockRef, setRefreshing };
}

async function refreshRecall(
  refetch: (mode?: "replace" | "background") => Promise<RecallStats | null>,
  refreshState: ReturnType<typeof useRefreshCooldown>,
  setRefreshing: (value: boolean) => void
) {
  if (refreshState.refreshLockRef.current) return;
  refreshState.refreshLockRef.current = true;
  setRefreshing(true);
  await refetch("background");
  refreshState.cooldownTimerRef.current = setTimeout(() => {
    refreshState.cooldownTimerRef.current = null;
    refreshState.refreshLockRef.current = false;
    setRefreshing(false);
  }, REFRESH_COOLDOWN_MS);
}

function RecallPageView({ controller }: { readonly controller: ReturnType<typeof useRecallController> }) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-8 font-mono">
        <RecallHeader controller={controller} />
        <RecallLoadState controller={controller} />
        {controller.data !== null ? <RecallStatsBody stats={controller.data} t={controller.t} /> : null}
      </div>
    </div>
  );
}

function RecallHeader({ controller }: { readonly controller: ReturnType<typeof useRecallController> }) {
  return (
    <header className="mb-10 flex flex-wrap items-end justify-between gap-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold text-ink-600">{controller.t("recall:title")}</h1>
        <p className="max-w-2xl text-sm text-ink-700/60">{controller.t("recall:subtitle")}</p>
      </div>
      <div className="flex items-end gap-3">
        <WindowToggle choice={controller.windowChoice} onChoose={controller.setWindowChoice} t={controller.t} />
        <RefreshButton refreshing={controller.refreshing} onRefresh={controller.handleRefresh} t={controller.t} />
      </div>
    </header>
  );
}

function RecallLoadState({ controller }: { readonly controller: ReturnType<typeof useRecallController> }) {
  return (
    <>
      {controller.loading && controller.data === null ? (
        <p data-testid="recall-loading" className="font-mono text-sm text-ink-700/60">
          {controller.t("recall:loading")}
        </p>
      ) : null}
      {controller.error !== null && controller.data === null ? (
        <p data-testid="recall-error" className="font-mono text-sm text-state-error-text">
          {controller.t("recall:error", { message: controller.error })}
        </p>
      ) : null}
    </>
  );
}

function RecallStatsBody(props: {
  readonly stats: RecallStats;
  readonly t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <>
      <KpiGrid stats={props.stats} t={props.t} />
      <DetailGrid stats={props.stats} t={props.t} />
      <RecallWindowMeta stats={props.stats} t={props.t} />
    </>
  );
}

function KpiGrid({ stats, t }: { readonly stats: RecallStats; readonly t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <KpiCard testId="recall-kpi-total" label={t("recall:kpi.total")} value={String(stats.recall.total)} />
      <KpiCard testId="recall-kpi-sessions" label={t("recall:kpi.sessions")} value={String(stats.recall.unique_sessions)} />
      <KpiCard testId="recall-kpi-runs" label={t("recall:kpi.runs")} value={String(stats.recall.unique_runs)} />
      <KpiCard testId="recall-kpi-miss" label={t("recall:kpi.miss")} value={formatRatio(stats.recall.miss_ratio)} />
      <KpiCard testId="recall-kpi-used" label={t("recall:kpi.used")} value={formatRatio(stats.usage.used_ratio)} />
      <KpiCard testId="recall-kpi-follow" label={t("recall:kpi.follow")} value={formatRatio(stats.usage.follow_through_ratio)} />
    </div>
  );
}

function DetailGrid({ stats, t }: { readonly stats: RecallStats; readonly t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <DetailRow label={t("recall:detail.p50Pointer")} value={String(stats.recall.p50_pointer_count)} />
      <DetailRow label={t("recall:detail.p50Latency")} value={`${stats.recall.p50_latency_ms} ms`} />
      <DetailRow label={t("recall:detail.embeddingQueries")} value={String(stats.embedding.total_queries)} hint={t("recall:detail.embeddingReturned", { count: String(stats.embedding.returned_candidate_count) })} />
      <DetailRow label={t("recall:detail.embeddingLatency")} value={`p50 ${stats.embedding.p50_latency_ms} / p95 ${stats.embedding.p95_latency_ms} / p99 ${stats.embedding.p99_latency_ms} ms`} hint={formatLatencyBuckets(stats.embedding.latency_buckets)} />
      <DetailRow label={t("recall:detail.nullRun")} value={String(stats.recall.null_run)} />
      <DetailRow label={t("recall:detail.usageTotal")} value={`${stats.usage.used} / ${stats.usage.skipped} / ${stats.usage.not_applicable}`} hint={t("recall:detail.usageHint")} />
    </section>
  );
}

function RecallWindowMeta({ stats, t }: { readonly stats: RecallStats; readonly t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <section data-testid="recall-window-meta" className="text-[10px] uppercase tracking-widest text-ink-700/55">
      {t("recall:meta.window", { since: stats.window.since ?? "—", until: stats.window.until ?? t("recall:meta.now") })}
      {stats.window.excluded_agent_targets.length > 0 ? (
        <>{" · "}{t("recall:meta.excludedTargets", { targets: stats.window.excluded_agent_targets.join(", ") })}</>
      ) : null}
    </section>
  );
}

function WindowToggle(props: {
  readonly choice: WindowChoice;
  readonly onChoose: (next: WindowChoice) => void;
  readonly t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <div role="group" aria-label="Recall window" data-testid="recall-window-toggle" className="flex items-center gap-1 rounded-full border border-beige-300 bg-beige-50 p-0.5 shadow-sm">
      {(["24h", "7d", "30d"] as const).map((value) => (
        <button key={value} type="button" onClick={() => props.onChoose(value)} aria-pressed={props.choice === value} className={"rounded-full px-2 py-0.5 text-[10px] font-mono uppercase transition-colors " + (props.choice === value ? "bg-ink-600 text-beige-50" : "text-ink-700/60 hover:text-ink-700")}>
          {props.t(WINDOW_LABEL_KEY[value])}
        </button>
      ))}
    </div>
  );
}

function RefreshButton(props: {
  readonly refreshing: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <button type="button" onClick={() => void props.onRefresh()} disabled={props.refreshing} className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-widest text-ink-700/60 transition-colors hover:text-ink-700 disabled:opacity-50" aria-label={props.t("common:refresh.aria")}>
      <RefreshCcw className={`h-3 w-3 ${props.refreshing ? "animate-spin" : ""}`} />
      {props.t("common:refresh")}
    </button>
  );
}

function RecallNoWorkspace({ title }: { readonly title: string }) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div role="alert" data-testid="recall-no-workspace" className="mx-auto w-full max-w-4xl p-8 font-mono text-sm text-ink-700">
        <h1 className="mb-3 text-2xl font-bold uppercase tracking-widest text-ink-600">{title}</h1>
      </div>
    </div>
  );
}

function KpiCard(props: { readonly label: string; readonly value: string; readonly testId?: string }) {
  return (
    <div data-testid={props.testId} className="flex flex-col gap-2 rounded-lg border border-beige-200 bg-beige-50 p-4">
      <span className="text-[10px] font-bold uppercase tracking-widest text-ink-700/40">{props.label}</span>
      <span className="text-2xl font-bold tabular-nums text-ink-600">{props.value}</span>
    </div>
  );
}

function DetailRow(props: { readonly hint?: string; readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-beige-200 bg-beige-50/70 p-4">
      <span className="text-[10px] font-bold uppercase tracking-widest text-ink-700/40">{props.label}</span>
      <span className="font-mono text-base tabular-nums text-ink-600">{props.value}</span>
      {props.hint !== undefined ? <span className="text-[10px] text-ink-700/40">{props.hint}</span> : null}
    </div>
  );
}

async function fetchRecallStats(
  workspaceId: string | null,
  windowChoice: WindowChoice,
  signal: AbortSignal
): Promise<RecallStats> {
  const since = new Date(Date.now() - WINDOW_HOURS[windowChoice] * 60 * 60 * 1000).toISOString();
  const search = new URLSearchParams();
  search.set("since", since);
  const envelope = await apiFetch<RecallStatsEnvelope>(`/recall-stats/${workspaceId}?${search.toString()}`, { signal });
  return envelope.data;
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatLatencyBuckets(
  buckets: readonly Readonly<{ readonly label: string; readonly count: number }>[]
): string {
  return buckets.map((bucket) => `${bucket.label}: ${bucket.count}`).join(" · ");
}
