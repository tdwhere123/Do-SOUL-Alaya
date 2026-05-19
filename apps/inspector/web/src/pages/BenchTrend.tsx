import { useEffect, useMemo, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { apiFetch } from "../api";
import { useI18n } from "../i18n/Locale";

interface BenchTrendPoint {
  readonly slug: string;
  readonly bench_name: string;
  readonly split: string;
  readonly run_at: string;
  readonly embedding_provider: string;
  readonly policy_shape: string;
  readonly simulate_report: string;
  readonly evaluated_count: number;
  readonly sample_size: number;
  readonly r_at_1: number;
  readonly r_at_5: number;
  readonly r_at_10: number;
  readonly latency_ms_p95: number;
  readonly token_saved_ratio_vs_full_prompt: number;
  readonly path_expansion_share: number | null;
  readonly graph_expansion_share: number | null;
}

interface BenchTrend {
  readonly bench_name: string;
  readonly history_count: number;
  readonly points: readonly BenchTrendPoint[];
}

interface BenchTrendResponse {
  readonly success: boolean;
  readonly data: {
    readonly self: BenchTrend | null;
    readonly public: BenchTrend | null;
    readonly public_multiturn: BenchTrend | null;
    readonly public_crossquestion: BenchTrend | null;
    readonly public_locomo: BenchTrend | null;
    readonly live: BenchTrend | null;
    readonly errors: Readonly<Record<string, string | null>>;
  };
}

const BENCH_ORDER = [
  "public",
  "public_locomo",
  "public_multiturn",
  "public_crossquestion",
  "self",
  "live"
] as const;

const METRICS = [
  { key: "r_at_5", label: "R@5", format: formatPercent },
  { key: "r_at_10", label: "R@10", format: formatPercent },
  { key: "latency_ms_p95", label: "p95", format: formatMs },
  { key: "token_saved_ratio_vs_full_prompt", label: "Saved", format: formatPercent },
  { key: "path_expansion_share", label: "Path", format: formatPercentOrDash },
  { key: "graph_expansion_share", label: "Graph", format: formatPercentOrDash }
] as const;

export default function BenchTrendPage() {
  const { t } = useI18n();
  const [data, setData] = useState<BenchTrendResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch<BenchTrendResponse>("/bench-trend", {
        params: { limit: "30" }
      });
      setData(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const benches = useMemo(
    () =>
      BENCH_ORDER.map((key) => ({ key, trend: data?.[key] ?? null })).filter(
        (item) => item.trend !== null && item.trend.points.length > 0
      ),
    [data]
  );

  return (
    <section className="h-full overflow-y-auto bg-beige-50 p-5 space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-700">{t("benchTrend:title")}</h1>
          <p className="text-sm text-ink-700/60 mt-1">{t("benchTrend:subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          aria-label={t("common:refresh.aria")}
          className="inline-flex items-center justify-center gap-2 rounded border border-beige-300 bg-beige-100 px-3 py-2 text-sm text-ink-700 hover:bg-beige-200"
        >
          <RefreshCcw className="h-4 w-4" />
          {t("common:refresh")}
        </button>
      </header>

      {loading ? <p className="text-sm text-ink-700/60">{t("benchTrend:loading")}</p> : null}
      {error !== null ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {t("benchTrend:error").replace("{message}", error)}
        </p>
      ) : null}
      {!loading && error === null && benches.length === 0 ? (
        <p className="text-sm text-ink-700/60">{t("benchTrend:empty")}</p>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {benches.map(({ key, trend }) => (
          <article
            key={key}
            data-testid={`bench-trend-${key}`}
            className="rounded border border-beige-200 bg-white/80 p-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink-700">
                  {labelForBench(key)}
                </h2>
                <p className="mt-1 text-xs text-ink-700/55">
                  {trend!.history_count} {t("benchTrend:historySuffix")}
                </p>
              </div>
              <span className="rounded border border-beige-200 px-2 py-1 text-xs text-ink-700/65">
                {trend!.points.at(-1)?.split ?? key}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {METRICS.map((metric) => (
                <MetricPanel
                  key={metric.key}
                  label={metric.label}
                  points={trend!.points}
                  field={metric.key}
                  format={metric.format}
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MetricPanel({
  label,
  points,
  field,
  format
}: {
  readonly label: string;
  readonly points: readonly BenchTrendPoint[];
  readonly field: keyof BenchTrendPoint;
  readonly format: (value: number | null) => string;
}) {
  const values = points
    .map((point) => point[field])
    .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));
  const latest = values.at(-1) ?? null;
  return (
    <div className="rounded border border-beige-200 bg-beige-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-700/65">{label}</span>
        <span className="text-sm font-semibold text-ink-700">{format(latest)}</span>
      </div>
      <Sparkline values={values} />
    </div>
  );
}

function Sparkline({ values }: { readonly values: readonly (number | null)[] }) {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length < 2) {
    return <div className="mt-3 h-12 rounded bg-beige-100" />;
  }
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const range = max - min || 1;
  const step = 100 / Math.max(values.length - 1, 1);
  const points = values
    .map((value, index) => {
      if (value === null) return null;
      const x = index * step;
      const y = 44 - ((value - min) / range) * 38;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter((value): value is string => value !== null)
    .join(" ");

  return (
    <svg className="mt-3 h-12 w-full" viewBox="0 0 100 48" role="img" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-morandi-sage"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function labelForBench(key: string): string {
  switch (key) {
    case "public":
      return "LongMemEval-S";
    case "public_locomo":
      return "LoCoMo";
    case "public_multiturn":
      return "LongMemEval Multi-turn";
    case "public_crossquestion":
      return "LongMemEval Cross-question";
    case "self":
      return "Self-bench";
    case "live":
      return "Live strict-real";
    default:
      return key;
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
