import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, CheckSquare, Layers, RefreshCcw, Zap } from "lucide-react";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useDaemonHealth } from "../hooks/useDaemonHealth";
import { useI18n } from "../i18n/Locale";
import type { DictKey } from "../i18n/dict";

interface PendingCountEnvelope {
  readonly success: boolean;
  readonly data: { readonly total_count: number };
}

export default function OverviewPage() {
  const { t } = useI18n();
  const { state, indicator, refresh, refreshing } = useDaemonHealth();
  const [pendingCount, setPendingCount] = useState<number | null>(null);
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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <SummaryCard
            icon={<Zap className="w-4 h-4" />}
            label={t("overview:card.daemon.label")}
            value={t(daemonValue)}
            subtitle={t("overview:card.daemon.subtitle")}
            link={{ to: "/status", text: t("overview:linkStatus") }}
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
            link={{ to: "/proposals", text: t("overview:linkProposals") }}
            testId="overview-card-proposals"
          />
          <SummaryCard
            icon={<Activity className="w-4 h-4" />}
            label={t("overview:card.recall.label")}
            value={t("overview:card.recall.placeholder")}
            subtitle={t("overview:card.recall.subtitle")}
            testId="overview-card-recall"
          />
          <SummaryCard
            icon={<Layers className="w-4 h-4" />}
            label={t("overview:card.tier.label")}
            value={t("overview:card.tier.placeholder")}
            subtitle={t("overview:card.tier.subtitle")}
            testId="overview-card-tier"
          />
        </div>
      </div>
    </div>
  );
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
