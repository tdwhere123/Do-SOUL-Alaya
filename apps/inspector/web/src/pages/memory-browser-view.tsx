import { RefreshCcw, X } from "lucide-react";
import { useI18n } from "../i18n/locale";
import {
  DIMENSION_OPTIONS,
  FilterChipGroup,
  SCOPE_OPTIONS,
  formatRatio,
  truncate,
  type ConflictFilter,
  type DimensionFilter,
  type EvidenceCapsuleShape,
  type MemoryEntryRow,
  type ScopeFilter
} from "./memory-browser-support";
import type { MemoryBrowserController } from "./memory-browser-controller";

type Translate = ReturnType<typeof useI18n>["t"];

interface MemoryBrowserPageViewProps {
  readonly title: string;
  readonly controller: MemoryBrowserController;
  readonly promoteLabel: string;
  readonly promoteAriaLabel: (id: string) => string;
}

export function MemoryBrowserPageView(props: MemoryBrowserPageViewProps) {
  const { controller } = props;
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col">
      <MemoryBrowserHeader t={t} title={props.title} controller={controller} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <MemoryTablePanel t={t} controller={controller} />
        {controller.selectedRow !== null ? (
          <EvidencePanel
            t={t}
            pointer={controller.pointer}
            pointerLoading={controller.pointerLoading}
            promoteAriaLabel={props.promoteAriaLabel}
            promoteBusyIds={controller.promoteBusyIds}
            promoteLabel={props.promoteLabel}
            row={controller.selectedRow}
            onClose={controller.closeSelection}
            onOpenEvidence={controller.openEvidence}
            onPromote={controller.promoteToStrictlyGoverned}
          />
        ) : null}
      </div>
    </div>
  );
}

function MemoryBrowserHeader(props: {
  readonly t: Translate;
  readonly title: string;
  readonly controller: MemoryBrowserController;
}) {
  const { controller } = props;
  return (
    <header className="border-b border-beige-300 bg-beige-50 px-6 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-mono uppercase tracking-widest text-ink-700">
          {props.title}
        </h1>
        <button
          type="button"
          aria-label={props.t("common:refresh")}
          className="flex items-center gap-2 border border-beige-300 px-3 py-1.5 text-xs font-mono uppercase hover:bg-beige-100 disabled:opacity-50"
          disabled={controller.refreshing}
          onClick={() => void controller.handleRefresh()}
        >
          <RefreshCcw className={`h-3 w-3 ${controller.refreshing ? "animate-spin" : ""}`} />
          {props.t("common:refresh")}
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <FilterChipGroup
          label={props.t("memoryBrowser:filter.dimension")}
          value={controller.dimensionFilter}
          options={["all", ...DIMENSION_OPTIONS]}
          onChange={(value) => controller.setDimensionFilter(value as DimensionFilter)}
        />
        <FilterChipGroup
          label={props.t("memoryBrowser:filter.scope")}
          value={controller.scopeFilter}
          options={["all", ...SCOPE_OPTIONS]}
          onChange={(value) => controller.setScopeFilter(value as ScopeFilter)}
        />
        <FilterChipGroup
          label={props.t("memoryBrowser:filter.conflicts")}
          value={controller.conflictFilter}
          options={["any", "has_conflict"]}
          onChange={(value) => controller.setConflictFilter(value as ConflictFilter)}
        />
      </div>
    </header>
  );
}

function MemoryTablePanel(props: {
  readonly t: Translate;
  readonly controller: MemoryBrowserController;
}) {
  const { controller } = props;
  return (
    <main className="flex-1 overflow-auto">
      {controller.loading ? (
        <div className="p-8 font-mono text-sm text-ink-500">
          {props.t("memoryBrowser:state.loading")}
        </div>
      ) : controller.error !== null ? (
        <div className="p-8 font-mono text-sm text-red-600">
          {props.t("memoryBrowser:state.error", { message: controller.error })}
        </div>
      ) : controller.rows.length === 0 ? (
        <div className="p-8 font-mono text-sm text-ink-500">
          {props.t("memoryBrowser:state.empty")}
        </div>
      ) : (
        <MemoryRowsTable controller={controller} />
      )}
      {!controller.loading && controller.error === null ? (
        <MemoryPagination t={props.t} controller={controller} />
      ) : null}
    </main>
  );
}

function MemoryRowsTable({ controller }: { readonly controller: MemoryBrowserController }) {
  const { t } = useI18n();
  return (
    <table className="w-full font-mono text-xs">
      <thead className="sticky top-0 bg-beige-100">
        <tr>
          <th className="px-3 py-2 text-left">object_id</th>
          <th className="px-3 py-2 text-left">content</th>
          <th className="px-3 py-2 text-left">dim</th>
          <th className="px-3 py-2 text-left">scope</th>
          <th className="px-3 py-2 text-left">tier</th>
          <th className="px-3 py-2 text-left">activation</th>
          <th className="px-3 py-2 text-left">conflicts</th>
        </tr>
      </thead>
      <tbody>
        {controller.rows.map((row) => (
          <MemoryTableRow
            key={row.object_id}
            row={row}
            selected={controller.selectedRow?.object_id === row.object_id}
            t={t}
            onSelect={controller.selectRow}
          />
        ))}
      </tbody>
    </table>
  );
}

function MemoryTableRow(props: {
  readonly t: Translate;
  readonly row: MemoryEntryRow;
  readonly selected: boolean;
  readonly onSelect: (row: MemoryEntryRow) => void;
}) {
  const { row } = props;
  return (
    <tr
      className={`cursor-pointer border-t border-beige-200 hover:bg-beige-50 ${
        props.selected ? "bg-beige-100" : ""
      }`}
      tabIndex={0}
      aria-label={props.t("memoryBrowser:row.selectAria", { id: row.object_id })}
      aria-selected={props.selected}
      onClick={() => props.onSelect(row)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect(row);
        }
      }}
    >
      <td className="max-w-xs truncate px-3 py-2">{row.object_id.slice(0, 8)}…</td>
      <td className="px-3 py-2">{truncate(row.content, 80)}</td>
      <td className="px-3 py-2">{row.dimension}</td>
      <td className="px-3 py-2">{row.scope_class}</td>
      <td className="px-3 py-2">{row.storage_tier ?? "—"}</td>
      <td className="px-3 py-2">{formatRatio(row.activation_score)}</td>
      <td className="px-3 py-2">{row.contradiction_count ?? 0}</td>
    </tr>
  );
}

function MemoryPagination(props: {
  readonly t: Translate;
  readonly controller: MemoryBrowserController;
}) {
  const { controller } = props;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-beige-200 bg-beige-50 px-4 py-3 font-mono text-[11px] text-ink-500">
      <span data-testid="memory-pagination-status">{controller.paginationStatus}</span>
      {controller.hasMoreRows ? (
        <button
          type="button"
          data-testid="memory-load-more"
          disabled={controller.loadingMore || controller.refreshing}
          onClick={() => void controller.loadMore()}
          className="border border-beige-300 px-3 py-1 text-[10px] uppercase hover:bg-beige-100 disabled:opacity-50"
        >
          {controller.loadingMore
            ? props.t("memoryBrowser:pagination.loading")
            : props.t("memoryBrowser:pagination.loadMore")}
        </button>
      ) : null}
    </div>
  );
}

function EvidencePanel(props: {
  readonly t: Translate;
  readonly row: MemoryEntryRow;
  readonly pointer: EvidenceCapsuleShape | null;
  readonly pointerLoading: boolean;
  readonly promoteBusyIds: ReadonlySet<string>;
  readonly promoteLabel: string;
  readonly promoteAriaLabel: (id: string) => string;
  readonly onClose: () => void;
  readonly onOpenEvidence: (evidenceId: string) => Promise<void>;
  readonly onPromote: (memoryId: string) => Promise<void>;
}) {
  return (
    <aside
      data-testid="memory-evidence-panel"
      className="w-full shrink-0 overflow-auto border-t border-beige-300 bg-beige-50 md:w-96 md:border-l md:border-t-0"
    >
      <EvidencePanelHeader t={props.t} onClose={props.onClose} />
      <div className="space-y-3 p-4 font-mono text-xs">
        <MemoryDetail t={props.t} row={props.row} />
        <PromoteButton {...props} />
        <EvidenceRefs t={props.t} row={props.row} onOpenEvidence={props.onOpenEvidence} />
        {props.pointerLoading ? (
          <div className="text-ink-500">{props.t("memoryBrowser:evidence.loading")}</div>
        ) : null}
        {props.pointer !== null ? <PointerDetails t={props.t} pointer={props.pointer} /> : null}
      </div>
    </aside>
  );
}

function EvidencePanelHeader(props: { readonly t: Translate; readonly onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-beige-300 px-4 py-3">
      <h2 className="font-mono text-xs uppercase tracking-widest text-ink-700">
        {props.t("memoryBrowser:evidence.title")}
      </h2>
      <button
        type="button"
        aria-label={props.t("memoryBrowser:evidence.close")}
        onClick={props.onClose}
        className="p-1 hover:bg-beige-200"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function MemoryDetail(props: { readonly t: Translate; readonly row: MemoryEntryRow }) {
  return (
    <>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-ink-500">
          {props.t("memoryBrowser:detail.memoryId")}
        </div>
        <div className="break-all">{props.row.object_id}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-ink-500">
          {props.t("memoryBrowser:detail.distilledContent")}
        </div>
        <div className="whitespace-pre-wrap">{props.row.content}</div>
      </div>
    </>
  );
}

function PromoteButton(props: {
  readonly row: MemoryEntryRow;
  readonly promoteBusyIds: ReadonlySet<string>;
  readonly promoteLabel: string;
  readonly promoteAriaLabel: (id: string) => string;
  readonly onPromote: (memoryId: string) => Promise<void>;
}) {
  return (
    <div>
      <button
        type="button"
        data-testid="promote-strictly-governed"
        aria-label={props.promoteAriaLabel(props.row.object_id)}
        disabled={props.promoteBusyIds.has(props.row.object_id)}
        onClick={() => void props.onPromote(props.row.object_id)}
        className="w-full border border-ink-600 px-3 py-1.5 font-mono text-xs uppercase text-ink-600 hover:bg-ink-600 hover:text-beige-50 disabled:opacity-50"
      >
        {props.promoteLabel}
      </button>
    </div>
  );
}

function EvidenceRefs(props: {
  readonly t: Translate;
  readonly row: MemoryEntryRow;
  readonly onOpenEvidence: (evidenceId: string) => Promise<void>;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-ink-500">
        {props.t("memoryBrowser:detail.evidenceRefs")}
      </div>
      {props.row.evidence_refs.length === 0 ? (
        <div className="text-ink-500">{props.t("memoryBrowser:detail.noEvidenceRefs")}</div>
      ) : (
        <ul className="space-y-1">
          {props.row.evidence_refs.map((ref) => (
            <li key={ref}>
              <button
                type="button"
                onClick={() => void props.onOpenEvidence(ref)}
                className="text-left underline decoration-dotted hover:text-ink-700"
              >
                {ref.slice(0, 12)}…
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PointerDetails(props: { readonly t: Translate; readonly pointer: EvidenceCapsuleShape }) {
  return (
    <>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-ink-500">
          {props.t("memoryBrowser:detail.evidenceObjectKind")}
        </div>
        <div>{props.pointer.object_kind}</div>
      </div>
      {props.pointer.gist !== undefined && props.pointer.gist !== null ? (
        <PointerText label={props.t("memoryBrowser:detail.gist")} value={props.pointer.gist} />
      ) : null}
      {props.pointer.excerpt !== undefined && props.pointer.excerpt !== null ? (
        <PointerText
          label={props.t("memoryBrowser:detail.excerpt")}
          value={props.pointer.excerpt}
        />
      ) : null}
    </>
  );
}

function PointerText({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-ink-500">{label}</div>
      <div className="whitespace-pre-wrap">{value}</div>
    </div>
  );
}
