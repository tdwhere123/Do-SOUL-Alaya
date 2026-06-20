import { useI18n } from "../../i18n/Locale";
import { GraphLegend } from "./support";
import type { GraphData, ViewMode } from "./types";

interface SearchTimeHits {
  readonly ids: ReadonlySet<string>;
  readonly windowLabel: string;
}

interface GraphOverlaysProps {
  readonly data: GraphData | null;
  readonly effectiveMode: ViewMode;
  readonly error: string | null;
  readonly largeGraphMode: boolean;
  readonly loading: boolean;
  readonly lowFpsDetected: boolean;
  readonly searchError: string | null;
  readonly searchTimeHits: SearchTimeHits | null;
  readonly webglSupported: boolean;
}

export default function GraphOverlays(props: GraphOverlaysProps) {
  return (
    <>
      <GraphAlertOverlays {...props} />
      <GraphLoadOverlays loading={props.loading} error={props.error} />
      <GraphMetaOverlays data={props.data} effectiveMode={props.effectiveMode} />
    </>
  );
}

function GraphAlertOverlays(props: GraphOverlaysProps) {
  return (
    <>
      <WebglLockedOverlay data={props.data} webglSupported={props.webglSupported} />
      <SearchTimeWindowOverlay searchTimeHits={props.searchTimeHits} />
      <SearchErrorOverlay searchError={props.searchError} />
      <LargeGraphOverlay
        data={props.data}
        largeGraphMode={props.largeGraphMode}
        lowFpsDetected={props.lowFpsDetected}
      />
    </>
  );
}

function GraphLoadOverlays(props: { readonly loading: boolean; readonly error: string | null }) {
  return (
    <>
      {props.loading ? <LoadingOverlay /> : null}
      {props.error ? <ErrorOverlay error={props.error} /> : null}
    </>
  );
}

function GraphMetaOverlays(props: {
  readonly data: GraphData | null;
  readonly effectiveMode: ViewMode;
}) {
  if (!props.data) return null;
  return (
    <>
      <GraphMetaChip data={props.data} />
      <GraphLegend />
      {props.effectiveMode === "3d" ? <ThreeDHint /> : null}
    </>
  );
}

function WebglLockedOverlay(props: { readonly data: GraphData | null; readonly webglSupported: boolean }) {
  const { t } = useI18n();
  if (!props.data || props.webglSupported) return null;
  return (
    <div className="absolute left-4 top-16 z-20 max-w-md rounded-md border border-state-warning/35 bg-beige-50/95 px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-700/65 shadow-sm">
      {t("graph:webgl.locked")}
    </div>
  );
}

function SearchTimeWindowOverlay(props: { readonly searchTimeHits: SearchTimeHits | null }) {
  const { t } = useI18n();
  if (!props.searchTimeHits) return null;
  return (
    <div className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-full border border-state-info/35 bg-beige-50/95 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-ink-700/70 shadow-sm" data-testid="search-time-window-chip">
      {t("graph:search.windowChip", {
        window: props.searchTimeHits.windowLabel,
        hits: props.searchTimeHits.ids.size
      })}
    </div>
  );
}

function SearchErrorOverlay(props: { readonly searchError: string | null }) {
  const { t } = useI18n();
  if (!props.searchError) return null;
  return (
    <div className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-md border border-morandi-pink bg-beige-50/95 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-state-error-text shadow-sm" data-testid="search-error-chip">
      {t("graph:search.errorChip", { message: props.searchError })}
    </div>
  );
}

function LargeGraphOverlay(props: {
  readonly data: GraphData | null;
  readonly largeGraphMode: boolean;
  readonly lowFpsDetected: boolean;
}) {
  const { t } = useI18n();
  if (!props.data || !props.largeGraphMode) return null;
  return (
    <div className="absolute left-4 top-16 z-20 max-w-md rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-700/65 shadow-sm">
      {t("graph:largeGraphMode")}
      {props.lowFpsDetected ? ` ${t("graph:largeGraphMode.lowFps")}` : ""}
    </div>
  );
}

function LoadingOverlay() {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-beige-100/50">
      <div className="flex flex-col items-center gap-3">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600/20 border-t-ink-600" />
        <p className="font-mono text-xs uppercase tracking-widest text-ink-600">
          {t("graph:scanning")}
        </p>
      </div>
    </div>
  );
}

function ErrorOverlay(props: { readonly error: string }) {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-8">
      <div className="max-w-md rounded-md border border-morandi-pink bg-beige-50 p-4">
        <h3 className="mb-2 font-mono font-bold text-ink-600">{t("graph:loadError")}</h3>
        <p className="font-mono text-sm text-ink-700">{props.error}</p>
      </div>
    </div>
  );
}

function GraphMetaChip(props: { readonly data: GraphData }) {
  const { t } = useI18n();
  return (
    <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 text-[10px] font-mono uppercase text-ink-700/55 shadow-sm">
      <span>{t("graph:meta.nodes", { shown: props.data.nodes.length, total: props.data.meta.nodeTotal })}</span>
      <span>·</span>
      <span>{t("graph:meta.edges", { shown: props.data.links.length, total: props.data.meta.edgeTotal })}</span>
      <span className="rounded-sm bg-ink-600/10 px-1.5 py-0.5 text-ink-700/65">
        {graphCompletenessLabel(props.data, t)}
      </span>
    </div>
  );
}

function ThreeDHint() {
  const { t } = useI18n();
  return (
    <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-700/55 shadow-sm">
      {t("graph:hint3d")}
    </div>
  );
}

function graphCompletenessLabel(data: GraphData, t: ReturnType<typeof useI18n>["t"]): string {
  const sampled = data.meta.truncated ||
    data.nodes.length < data.meta.nodeTotal ||
    data.links.length < data.meta.edgeTotal;
  return sampled ? t("graph:meta.sampled") : t("graph:meta.complete");
}
