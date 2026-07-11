import { RefreshCcw } from "lucide-react";
import { useI18n } from "../i18n/locale";
import type { BenchTrendPoint, VisibleBenchTrend } from "./bench-trend-types";
import type { BenchTrendState } from "./bench-trend-state";

const METRICS = [
  { key: "r_at_5", label: "R@5", format: formatPercent },
  { key: "r_at_10", label: "R@10", format: formatPercent },
  { key: "latency_ms_p95", label: "p95", format: formatMs },
  { key: "token_saved_ratio_vs_full_prompt", label: "Saved", format: formatPercent },
  { key: "recalled_context_tokens_mean", label: "Recall tok", format: formatTokensOrDash },
  { key: "path_expansion_share", label: "Path", format: formatPercentOrDash },
  { key: "graph_expansion_share", label: "Graph", format: formatPercentOrDash }
] as const;

export function BenchTrendView(props: { readonly state: BenchTrendState }) {
  const { t } = useI18n();
  return (
    <section className="h-full overflow-y-auto bg-beige-50 p-5 space-y-4">
      <BenchTrendHeader onRefresh={props.state.load} />
      <BenchTrendStatus state={props.state} />
      <BenchTrendGrid benches={props.state.benches} />
    </section>
  );
}

function BenchTrendHeader(props: { readonly onRefresh: () => Promise<void> }) {
  const { t } = useI18n();
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-ink-700">{t("benchTrend:title")}</h1>
        <p className="text-sm text-ink-700/60 mt-1">{t("benchTrend:subtitle")}</p>
      </div>
      <button type="button" onClick={() => void props.onRefresh()} aria-label={t("common:refresh.aria")} className="inline-flex items-center justify-center gap-2 rounded border border-beige-300 bg-beige-100 px-3 py-2 text-sm text-ink-700 hover:bg-beige-200">
        <RefreshCcw className="h-4 w-4" />
        {t("common:refresh")}
      </button>
    </header>
  );
}

function BenchTrendStatus(props: { readonly state: BenchTrendState }) {
  const { t } = useI18n();
  if (props.state.loading) return <p className="text-sm text-ink-700/60">{t("benchTrend:loading")}</p>;
  if (props.state.error !== null) {
    return <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{t("benchTrend:error").replace("{message}", props.state.error)}</p>;
  }
  if (props.state.benches.length === 0) {
    return <p className="text-sm text-ink-700/60">{t("benchTrend:empty")}</p>;
  }
  return null;
}

function BenchTrendGrid(props: { readonly benches: readonly VisibleBenchTrend[] }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {props.benches.map((bench) => <BenchTrendCard key={bench.key} bench={bench} />)}
    </div>
  );
}

function BenchTrendCard(props: { readonly bench: VisibleBenchTrend }) {
  const { t } = useI18n();
  const latestSplit = props.bench.trend.points.at(-1)?.split ?? props.bench.key;
  return (
    <article data-testid={`bench-trend-${props.bench.key}`} className="rounded border border-beige-200 bg-white/80 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-700">{labelForBench(props.bench.key)}</h2>
          <p className="mt-1 text-xs text-ink-700/55">{props.bench.trend.history_count} {t("benchTrend:historySuffix")}</p>
        </div>
        <span className="rounded border border-beige-200 px-2 py-1 text-xs text-ink-700/65">
          {latestSplit}
        </span>
      </div>
      <MetricGrid points={props.bench.trend.points} />
    </article>
  );
}

function MetricGrid(props: { readonly points: readonly BenchTrendPoint[] }) {
  return (
    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      {METRICS.map((metric) => (
        <MetricPanel key={metric.key} label={metric.label} points={props.points} field={metric.key} format={metric.format} />
      ))}
    </div>
  );
}

function MetricPanel(props: {
  readonly label: string;
  readonly points: readonly BenchTrendPoint[];
  readonly field: keyof BenchTrendPoint;
  readonly format: (value: number | null) => string;
}) {
  const values = metricValues(props.points, props.field);
  return (
    <div className="rounded border border-beige-200 bg-beige-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-700/65">{props.label}</span>
        <span className="text-sm font-semibold text-ink-700">{props.format(values.at(-1) ?? null)}</span>
      </div>
      <Sparkline values={values} />
    </div>
  );
}

function Sparkline({ values }: { readonly values: readonly (number | null)[] }) {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length < 2) return <div className="mt-3 h-12 rounded bg-beige-100" />;
  return (
    <svg className="mt-3 h-12 w-full" viewBox="0 0 100 48" role="img" aria-hidden="true">
      <polyline points={sparklinePoints(values, numeric)} fill="none" stroke="currentColor" strokeWidth="2" className="text-morandi-sage" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function sparklinePoints(values: readonly (number | null)[], numeric: readonly number[]): string {
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const range = max - min || 1;
  const step = 100 / Math.max(values.length - 1, 1);
  return values
    .map((value, index) => value === null ? null : `${(index * step).toFixed(2)},${(44 - ((value - min) / range) * 38).toFixed(2)}`)
    .filter((value): value is string => value !== null)
    .join(" ");
}

function metricValues(points: readonly BenchTrendPoint[], field: keyof BenchTrendPoint) {
  return points.map((point) => point[field]).map((value) => typeof value === "number" && Number.isFinite(value) ? value : null);
}

function labelForBench(key: string): string {
  switch (key) {
    case "public": return "LongMemEval-S";
    case "public_locomo": return "LoCoMo";
    case "public_multiturn": return "LongMemEval Multi-turn";
    case "public_crossquestion": return "LongMemEval Cross-question";
    case "self": return "Self-bench";
    case "live": return "Live strict-real";
    default: return key;
  }
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatPercentOrDash(value: number | null): string {
  return formatPercent(value);
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function formatTokensOrDash(value: number | null): string {
  return value === null ? "—" : `${Math.round(value).toLocaleString()} tok`;
}
