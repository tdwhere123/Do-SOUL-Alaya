import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw, X } from "lucide-react";
import { apiFetch, apiFetchWithHeaders, getWorkspaceId, type ApiError } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useI18n } from "../i18n/Locale";
import { useToasts } from "../components/Toast";

interface MemoryEntryRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly content: string;
  readonly dimension: string;
  readonly scope_class: string;
  readonly domain_tags: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly created_at: string;
  readonly contradiction_count?: number | null;
  readonly source_kind?: string | null;
  readonly storage_tier?: string | null;
  readonly activation_score?: number | null;
}

interface MemoryEntryListEnvelope {
  readonly success: boolean;
  readonly data: readonly MemoryEntryRow[];
}

interface EvidenceCapsuleShape {
  readonly object_id: string;
  readonly object_kind: string;
  readonly gist?: string | null;
  readonly excerpt?: string | null;
}

interface EvidenceEnvelope {
  readonly success: boolean;
  readonly data: EvidenceCapsuleShape;
}

interface PromoteEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly proposal_id: string;
    readonly status: "created";
    readonly target_object_id: string;
    readonly target_object_kind: "path_relation";
    readonly requested_governance_class: "strictly_governed";
  };
}

interface MemoryPageData {
  readonly rows: readonly MemoryEntryRow[];
  readonly totalRows: number | null;
  readonly nextOffset: number;
  readonly hasMoreRows: boolean;
}

type DimensionFilter = "all" | string;
type ScopeFilter = "all" | string;
type ConflictFilter = "any" | "has_conflict";

const DIMENSION_OPTIONS: readonly string[] = [
  "preference",
  "procedure",
  "constraint",
  "hazard",
  "concept",
  "outcome"
];

const SCOPE_OPTIONS: readonly string[] = ["project", "global_domain", "session"];

const MEMORY_PAGE_SIZE = 200;

/**
 * MemoryBrowserPage lists memory entries with client-side scope/conflict
 * filters, paginated daemon reads, and evidence drill-in from the side panel.
 */
export default function MemoryBrowserPage() {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId();
  const isMountedRef = useRef(true);
  const queryVersionRef = useRef(0);
  const [rows, setRows] = useState<readonly MemoryEntryRow[]>([]);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMoreRows, setHasMoreRows] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dimensionFilter, setDimensionFilter] = useState<DimensionFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [conflictFilter, setConflictFilter] = useState<ConflictFilter>("any");
  const [selectedRow, setSelectedRow] = useState<MemoryEntryRow | null>(null);
  const [pointer, setPointer] = useState<EvidenceCapsuleShape | null>(null);
  const [pointerLoading, setPointerLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [promoteBusyId, setPromoteBusyId] = useState<string | null>(null);

  const fetchRows = useCallback(async (signal: AbortSignal): Promise<MemoryPageData> => {
    const search = new URLSearchParams();
    if (dimensionFilter !== "all") {
      search.set("dimension", dimensionFilter);
    }
    search.set("limit", String(MEMORY_PAGE_SIZE));
    search.set("offset", "0");
    const query = search.toString();
    const result = await apiFetchWithHeaders<MemoryEntryListEnvelope>(
      `/memory-entries/${workspaceId}${query.length > 0 ? `?${query}` : ""}`,
      { signal }
    );
    const pageRows = result.payload.data;
    const total = readOptionalIntegerHeader(result.headers, "x-total-count");
    const loadedCount = pageRows.length;

    return {
      rows: pageRows,
      totalRows: total,
      nextOffset: loadedCount,
      hasMoreRows: total === null ? pageRows.length === MEMORY_PAGE_SIZE : loadedCount < total
    };
  }, [dimensionFilter, workspaceId]);

  const {
    data: firstPage,
    error,
    loading,
    refetch
  } = useApiQuery(fetchRows, [workspaceId, dimensionFilter], {
    enabled: workspaceId !== null,
    onError: (message) => {
      showToast({ message: `Memory list fetch failed: ${message}`, type: "error" });
    }
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    queryVersionRef.current += 1;
    setRows([]);
    setTotalRows(null);
    setNextOffset(0);
    setHasMoreRows(false);
    setSelectedRow(null);
    setPointer(null);
  }, [dimensionFilter, workspaceId]);

  useEffect(() => {
    if (!firstPage) return;
    setRows(firstPage.rows);
    setTotalRows(firstPage.totalRows);
    setNextOffset(firstPage.nextOffset);
    setHasMoreRows(firstPage.hasMoreRows);
  }, [firstPage]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (scopeFilter !== "all" && row.scope_class !== scopeFilter) {
        return false;
      }
      if (conflictFilter === "has_conflict" && (row.contradiction_count ?? 0) === 0) {
        return false;
      }
      return true;
    });
  }, [conflictFilter, rows, scopeFilter]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch("background");
    if (isMountedRef.current) {
      setRefreshing(false);
    }
  }, [refetch]);

  const loadMore = useCallback(async () => {
    if (workspaceId === null) return;

    const version = queryVersionRef.current;
    setLoadingMore(true);
    try {
      const search = new URLSearchParams();
      if (dimensionFilter !== "all") {
        search.set("dimension", dimensionFilter);
      }
      search.set("limit", String(MEMORY_PAGE_SIZE));
      search.set("offset", String(nextOffset));
      const query = search.toString();
      const result = await apiFetchWithHeaders<MemoryEntryListEnvelope>(
        `/memory-entries/${workspaceId}${query.length > 0 ? `?${query}` : ""}`
      );
      if (!isMountedRef.current || version !== queryVersionRef.current) return;

      const pageRows = result.payload.data;
      const total = readOptionalIntegerHeader(result.headers, "x-total-count");
      const loadedCount = nextOffset + pageRows.length;
      setRows((previous) => [...previous, ...pageRows]);
      setTotalRows(total);
      setNextOffset(loadedCount);
      setHasMoreRows(total === null ? pageRows.length === MEMORY_PAGE_SIZE : loadedCount < total);
    } catch (err) {
      if ((err as ApiError).status === 401) return;
      const message = err instanceof Error ? err.message : "unknown error";
      showToast({ message: `Memory list fetch failed: ${message}`, type: "error" });
    } finally {
      if (isMountedRef.current && version === queryVersionRef.current) {
        setLoadingMore(false);
      }
    }
  }, [dimensionFilter, nextOffset, showToast, workspaceId]);

  const selectRow = useCallback((row: MemoryEntryRow) => {
    setSelectedRow(row);
    setPointer(null);
  }, []);

  const promoteToStrictlyGoverned = useCallback(
    async (memoryId: string) => {
      if (workspaceId === null) return;
      setPromoteBusyId(memoryId);
      try {
        const envelope = await apiFetch<PromoteEnvelope>(
          `/workspaces/${workspaceId}/soul/memory/${encodeURIComponent(memoryId)}/proposals/promote-strictly-governed`,
          {
            method: "POST",
            body: {}
          }
        );
        showToast({
          type: "success",
          message: `Proposal created: ${envelope.data.proposal_id} (path_relation → strictly_governed)`
        });
      } catch (err) {
        if ((err as ApiError).status === 401) return;
        const message = err instanceof Error ? err.message : "unknown error";
        showToast({ message: `Promote failed: ${message}`, type: "error" });
      } finally {
        if (isMountedRef.current) {
          setPromoteBusyId(null);
        }
      }
    },
    [showToast, workspaceId]
  );

  const openEvidence = useCallback(
    async (evidenceId: string) => {
      if (workspaceId === null) return;
      setPointerLoading(true);
      setPointer(null);
      try {
        const envelope = await apiFetch<EvidenceEnvelope>(
          `/pointers/${workspaceId}/${encodeURIComponent(evidenceId)}`
        );
        if (!isMountedRef.current) return;
        setPointer(envelope.data);
      } catch (err) {
        if (!isMountedRef.current) return;
        const message = err instanceof Error ? err.message : "unknown error";
        showToast({ message: `Evidence open failed: ${message}`, type: "error" });
      } finally {
        if (isMountedRef.current) {
          setPointerLoading(false);
        }
      }
    },
    [showToast, workspaceId]
  );

  if (workspaceId === null) {
    return <div className="p-8 font-mono text-sm text-ink-600">Workspace binding missing.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-beige-300 bg-beige-50 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-mono uppercase tracking-widest text-ink-700">
            {t("nav:memoryBrowser")}
          </h1>
          <button
            type="button"
            className="flex items-center gap-2 border border-beige-300 px-3 py-1.5 text-xs font-mono uppercase hover:bg-beige-100 disabled:opacity-50"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
          >
            <RefreshCcw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <FilterChipGroup
            label="dimension"
            value={dimensionFilter}
            options={["all", ...DIMENSION_OPTIONS]}
            onChange={(value) => setDimensionFilter(value as DimensionFilter)}
          />
          <FilterChipGroup
            label="scope"
            value={scopeFilter}
            options={["all", ...SCOPE_OPTIONS]}
            onChange={(value) => setScopeFilter(value as ScopeFilter)}
          />
          <FilterChipGroup
            label="conflicts"
            value={conflictFilter}
            options={["any", "has_conflict"]}
            onChange={(value) => setConflictFilter(value as ConflictFilter)}
          />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-auto">
          {loading ? (
            <div className="p-8 font-mono text-sm text-ink-500">Loading memories...</div>
          ) : error !== null ? (
            <div className="p-8 font-mono text-sm text-red-600">Error: {error}</div>
          ) : filteredRows.length === 0 ? (
            <div className="p-8 font-mono text-sm text-ink-500">
              No memories match the current filters.
            </div>
          ) : (
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
                {filteredRows.map((row) => (
                  <tr
                    key={row.object_id}
                    className={`cursor-pointer border-t border-beige-200 hover:bg-beige-50 ${
                      selectedRow?.object_id === row.object_id ? "bg-beige-100" : ""
                    }`}
                    onClick={() => selectRow(row)}
                  >
                    <td className="max-w-xs truncate px-3 py-2">{row.object_id.slice(0, 8)}…</td>
                    <td className="px-3 py-2">{truncate(row.content, 80)}</td>
                    <td className="px-3 py-2">{row.dimension}</td>
                    <td className="px-3 py-2">{row.scope_class}</td>
                    <td className="px-3 py-2">{row.storage_tier ?? "—"}</td>
                    <td className="px-3 py-2">{formatRatio(row.activation_score)}</td>
                    <td className="px-3 py-2">{row.contradiction_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!loading && error === null ? (
            <div className="flex items-center justify-between gap-3 border-t border-beige-200 bg-beige-50 px-4 py-3 font-mono text-[11px] text-ink-500">
              <span data-testid="memory-pagination-status">
                Showing {filteredRows.length} filtered / {rows.length}
                {totalRows === null ? "" : ` of ${totalRows}`} loaded
              </span>
              {hasMoreRows ? (
                <button
                  type="button"
                  data-testid="memory-load-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  className="border border-beige-300 px-3 py-1 text-[10px] uppercase hover:bg-beige-100 disabled:opacity-50"
                >
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              ) : null}
            </div>
          ) : null}
        </main>

        {selectedRow !== null ? (
          <aside className="w-96 overflow-auto border-l border-beige-300 bg-beige-50">
            <div className="flex items-center justify-between border-b border-beige-300 px-4 py-3">
              <h2 className="font-mono text-xs uppercase tracking-widest text-ink-700">Evidence</h2>
              <button
                type="button"
                onClick={() => {
                  setSelectedRow(null);
                  setPointer(null);
                }}
                className="p-1 hover:bg-beige-200"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="space-y-3 p-4 font-mono text-xs">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-ink-500">memory id</div>
                <div className="break-all">{selectedRow.object_id}</div>
              </div>
              <div>
                <button
                  type="button"
                  data-testid="promote-strictly-governed"
                  aria-label={t("healthInbox:row.promoteStrictlyGovernedAria", {
                    id: selectedRow.object_id
                  })}
                  disabled={promoteBusyId === selectedRow.object_id}
                  onClick={() => {
                    void promoteToStrictlyGoverned(selectedRow.object_id);
                  }}
                  className="w-full border border-ink-600 px-3 py-1.5 font-mono text-xs uppercase text-ink-600 hover:bg-ink-600 hover:text-beige-50 disabled:opacity-50"
                >
                  {t("healthInbox:row.promoteStrictlyGoverned")}
                </button>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-ink-500">
                  distilled content
                </div>
                <div className="whitespace-pre-wrap">{selectedRow.content}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-ink-500">
                  evidence refs
                </div>
                {selectedRow.evidence_refs.length === 0 ? (
                  <div className="text-ink-500">No evidence_refs on this memory.</div>
                ) : (
                  <ul className="space-y-1">
                    {selectedRow.evidence_refs.map((ref) => (
                      <li key={ref}>
                        <button
                          type="button"
                          onClick={() => {
                            void openEvidence(ref);
                          }}
                          className="text-left underline decoration-dotted hover:text-ink-700"
                        >
                          {ref.slice(0, 12)}…
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {pointerLoading ? <div className="text-ink-500">Loading evidence capsule...</div> : null}
              {pointer !== null ? (
                <>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-ink-500">
                      evidence object kind
                    </div>
                    <div>{pointer.object_kind}</div>
                  </div>
                  {pointer.gist !== undefined && pointer.gist !== null ? (
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-ink-500">gist</div>
                      <div className="whitespace-pre-wrap">{pointer.gist}</div>
                    </div>
                  ) : null}
                  {pointer.excerpt !== undefined && pointer.excerpt !== null ? (
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-ink-500">
                        excerpt
                      </div>
                      <div className="whitespace-pre-wrap">{pointer.excerpt}</div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function FilterChipGroup(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-ink-500">
        {props.label}:
      </span>
      {props.options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => props.onChange(option)}
          className={`px-2 py-0.5 text-[10px] font-mono uppercase border ${
            props.value === option
              ? "bg-ink-600 text-beige-50 border-ink-600"
              : "border-beige-300 text-ink-600 hover:bg-beige-100"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function readOptionalIntegerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
