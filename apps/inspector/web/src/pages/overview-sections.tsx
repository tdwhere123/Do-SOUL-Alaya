import type { ReactNode } from "react";
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
import type { useDaemonHealth } from "../hooks/useDaemonHealth";
import type { DictKey } from "../i18n/dict";
import type { BenchSummaryData, BenchSummaryShape } from "./overview-data";

type Translate = (key: DictKey, params?: Record<string, string | number>) => string;

export function OverviewDegradedAlert(props: { readonly message: string; readonly t: Translate }) {
  return (
    <div
      role="alert"
      data-testid="overview-degraded"
      className="mb-6 rounded border border-beige-300 bg-beige-200/50 px-4 py-2 font-mono text-xs text-ink-700/80"
    >
      {props.t("overview:degraded", { message: props.message })}
    </div>
  );
}

export function OverviewHeader(props: {
  readonly indicator: ReturnType<typeof useDaemonHealth>["indicator"];
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly t: Translate;
}) {
  return (
    <header className="mb-10 flex items-end justify-between gap-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold text-ink-600">{props.t("overview:title")}</h1>
        <p className="max-w-2xl text-sm text-ink-700/60">{props.t("overview:subtitle")}</p>
      </div>
      <OverviewRefreshControl {...props} />
    </header>
  );
}

function OverviewRefreshControl(props: {
  readonly indicator: ReturnType<typeof useDaemonHealth>["indicator"];
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly t: Translate;
}) {
  return (
    <div className="flex flex-col items-end gap-2">
      <div
        className={`flex items-center gap-2 ${props.indicator.colorClass}`}
        data-testid="overview-health-indicator"
      >
        <div className="h-2 w-2 animate-pulse rounded-full bg-current" />
        <span className="text-xs font-bold uppercase tracking-wider">
          {props.indicator.label}
        </span>
      </div>
      <button
        type="button"
        onClick={props.onRefresh}
        disabled={props.refreshing}
        className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-widest text-ink-700/60 transition-colors hover:text-ink-700 disabled:opacity-50"
        aria-label={props.t("common:refresh.aria")}
      >
        <RefreshCcw className={`h-3 w-3 ${props.refreshing ? "animate-spin" : ""}`} />
        {props.t("common:refresh")}
      </button>
    </div>
  );
}

export function OverviewSummaryGrid(props: {
  readonly daemonState: ReturnType<typeof useDaemonHealth>["state"];
  readonly pendingCount: number | null;
  readonly recallStats: { readonly total: number; readonly usedRatio: number } | null;
  readonly t: Translate;
}) {
  const t = props.t;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <SummaryCard
        icon={<Zap className="h-4 w-4" />}
        label={t("overview:card.daemon.label")}
        value={t(resolveDaemonLabelKey(props.daemonState))}
        subtitle={t("overview:card.daemon.subtitle")}
        link={{ to: "/system?tab=status", text: t("overview:linkStatus") }}
        testId="overview-card-daemon"
      />
      <ProposalSummaryCard pendingCount={props.pendingCount} t={t} />
      <RecallSummaryCard recallStats={props.recallStats} t={t} />
    </div>
  );
}

function ProposalSummaryCard(props: { readonly pendingCount: number | null; readonly t: Translate }) {
  const empty = props.pendingCount === 0;
  return (
    <SummaryCard
      icon={<CheckSquare className="h-4 w-4" />}
      label={props.t("overview:card.proposals.label")}
      value={props.pendingCount === null ? "—" : String(props.pendingCount)}
      subtitle={empty ? props.t("overview:card.proposals.empty") : props.t("overview:card.proposals.subtitle")}
      link={{ to: "/governance?tab=proposals", text: props.t("overview:linkProposals") }}
      testId="overview-card-proposals"
    />
  );
}

function RecallSummaryCard(props: {
  readonly recallStats: { readonly total: number; readonly usedRatio: number } | null;
  readonly t: Translate;
}) {
  return (
    <SummaryCard
      icon={<Activity className="h-4 w-4" />}
      label={props.t("overview:card.recall.label")}
      value={props.recallStats === null ? "—" : formatRatio(props.recallStats.usedRatio)}
      subtitle={recallSubtitle(props.recallStats, props.t)}
      link={{ to: "/recall", text: props.t("overview:linkRecall") }}
      testId="overview-card-recall"
    />
  );
}

export function BenchSummarySection(props: {
  readonly benchData: BenchSummaryData;
  readonly loaded: boolean;
  readonly t: Translate;
}) {
  return (
    <section className="mt-10" aria-labelledby="overview-bench-heading">
      <h2 id="overview-bench-heading" className="mb-4 text-sm font-bold uppercase tracking-widest text-ink-600">
        {props.t("overview:bench.section")}
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {benchCards(props.benchData, props.loaded, props.t).map((card) => (
          <BenchCard key={card.testId} {...card} />
        ))}
      </div>
    </section>
  );
}

function benchCards(data: BenchSummaryData, loaded: boolean, t: Translate): BenchCardProps[] {
  return [
    benchCard("overview-bench-self", <FlaskConical className="h-4 w-4" />, "self", data.self, loaded, t),
    benchCard("overview-bench-public", <Globe2 className="h-4 w-4" />, "public", data.public, loaded, t),
    benchCard("overview-bench-public-multiturn", <Repeat2 className="h-4 w-4" />, "publicMultiturn", data.publicMultiturn, loaded, t),
    benchCard("overview-bench-live", <ShieldCheck className="h-4 w-4" />, "live", data.live, loaded, t)
  ];
}

function benchCard(
  testId: string,
  icon: ReactNode,
  key: "self" | "public" | "publicMultiturn" | "live",
  summary: BenchSummaryShape | null,
  loaded: boolean,
  t: Translate
): BenchCardProps {
  return {
    empty: t("overview:bench.empty"),
    hint: t(`overview:bench.${key}.hint` as DictKey),
    icon,
    label: t(`overview:bench.${key}.label` as DictKey),
    loaded,
    summary,
    t,
    testId
  };
}

interface BenchCardProps {
  readonly empty: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly loaded: boolean;
  readonly summary: BenchSummaryShape | null;
  readonly t: Translate;
  readonly testId: string;
}

function BenchCard({ empty, hint, icon, label, loaded, summary, t, testId }: BenchCardProps) {
  return (
    <div data-testid={testId} className="flex flex-col gap-3 rounded-lg border border-beige-200 bg-beige-50 p-5">
      <div className="flex items-center gap-2 text-ink-700/40">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-widest">{label}</span>
      </div>
      {summary === null ? (
        <div className="text-[11px] text-ink-700/55" data-testid={`${testId}-empty`}>
          {loaded ? empty : t("overview:bench.loading")}
        </div>
      ) : (
        <BenchCardMetrics summary={summary} t={t} />
      )}
      <div className="mt-auto text-[10px] text-ink-700/40">{hint}</div>
    </div>
  );
}

function BenchCardMetrics(props: { readonly summary: BenchSummaryShape; readonly t: Translate }) {
  const summary = props.summary;
  return (
    <>
      <div className="text-3xl font-bold tabular-nums text-ink-600">
        {formatRatio(summary.payload.kpi.r_at_5)}
      </div>
      <div className="text-[11px] text-ink-700/55">
        R@5 · {benchDelta(summary, props.t)}
      </div>
      <div className="text-[10px] uppercase tracking-widest text-ink-700/55">
        {summary.payload.split} · {summary.latest_slug}
      </div>
      <div className="text-[10px] text-ink-700/40">
        {props.t("overview:bench.history", { count: summary.history_count })}
      </div>
    </>
  );
}

interface SummaryCardProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly link?: { readonly to: string; readonly text: string };
  readonly subtitle: string;
  readonly testId: string;
  readonly value: string;
}

function SummaryCard({ icon, label, link, subtitle, testId, value }: SummaryCardProps) {
  return (
    <div data-testid={testId} className="flex flex-col gap-3 rounded-lg border border-beige-200 bg-beige-50 p-5">
      <div className="flex items-center gap-2 text-ink-700/40">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-widest">{label}</span>
      </div>
      <div className="text-3xl font-bold tabular-nums text-ink-600">{value}</div>
      <div className="text-[11px] text-ink-700/55">{subtitle}</div>
      {link ? (
        <Link to={link.to} className="mt-auto text-[10px] uppercase tracking-widest text-ink-600 hover:text-ink-700">
          {link.text}
        </Link>
      ) : null}
    </div>
  );
}

function benchDelta(summary: BenchSummaryShape, t: Translate): string {
  if (summary.diff.r_at_5_delta_pp === null) return t("overview:bench.firstBaseline");
  return t("overview:bench.delta", { delta: formatDeltaPp(summary.diff.r_at_5_delta_pp) });
}

function recallSubtitle(
  recallStats: { readonly total: number; readonly usedRatio: number } | null,
  t: Translate
): string {
  if (recallStats === null) return t("overview:card.recall.subtitle");
  return t("overview:card.recall.usage", { total: recallStats.total });
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

function resolveDaemonLabelKey(state: ReturnType<typeof useDaemonHealth>["state"]): DictKey {
  if (state.kind === "degraded") return "overview:card.daemon.value.warming";
  if (state.kind === "ok" && state.status.daemon.ready) {
    return "overview:card.daemon.value.ready";
  }
  if (state.kind === "ok") return "overview:card.daemon.value.initializing";
  return "overview:card.daemon.value.offline";
}
