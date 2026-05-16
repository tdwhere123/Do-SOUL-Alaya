import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw, X } from "lucide-react";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
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

const SCOPE_OPTIONS: readonly string[] = [
  "project",
  "global_domain",
  "session"
];

export default function MemoryBrowserPage() {
  const { t } = useI18n();
  const workspaceId = getWorkspaceId();
  const [rows, setRows] = useState<readonly MemoryEntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimensionFilter, setDimensionFilter] = useState<DimensionFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [conflictFilter, setConflictFilter] = useState<ConflictFilter>("any");
  const [selectedRow, setSelectedRow] = useState<MemoryEntryRow | null>(null);
  const [pointer, setPointer] = useState<EvidenceCapsuleShape | null>(null);
  const [pointerLoading, setPointerLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const { showToast } = useToasts();

  const fetchRows = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    requestIdRef.current += 1;
    const myRequestId = requestIdRef.current;
    try {
      const search = new URLSearchParams();
      if (dimensionFilter !== "all") {
        search.set("dimension", dimensionFilter);
      }
      const query = search.toString();
      const envelope = await apiFetch<MemoryEntryListEnvelope>(
        `/memory-entries/${workspaceId}${query.length > 0 ? `?${query}` : ""}`
      );
      if (!isMountedRef.current || myRequestId !== requestIdRef.current) return;
      setRows(envelope.data);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current || myRequestId !== requestIdRef.current) return;
      if ((err as ApiError).status === 401) return;
      const message = err instanceof Error ? err.message : "unknown error";
      setError(message);
      showToast({ message: `Memory list fetch failed: ${message}`, type: "error" });
    } finally {
      if (isMountedRef.current && myRequestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [workspaceId, dimensionFilter, showToast]);

  useEffect(() => {
    isMountedRef.current = true;
    setLoading(true);
    void fetchRows();
    return () => {
      isMountedRef.current = false;
    };
  }, [fetchRows]);

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
  }, [rows, scopeFilter, conflictFilter]);

  const selectRow = useCallback((row: MemoryEntryRow) => {
    setSelectedRow(row);
    setPointer(null);
  }, []);

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
    [workspaceId, showToast]
  );

  if (workspaceId === null) {
    return (
      <div className="p-8 font-mono text-sm text-ink-600">
        Workspace binding missing.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 border-b border-beige-300 bg-beige-50">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-mono uppercase tracking-widest text-ink-700">
            {t("nav:memoryBrowser")}
          </h1>
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono uppercase border border-beige-300 hover:bg-beige-100 disabled:opacity-50"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void fetchRows();
            }}
          >
            <RefreshCcw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <FilterChipGroup
            label="dimension"
            value={dimensionFilter}
            options={["all", ...DIMENSION_OPTIONS]}
            onChange={(v) => setDimensionFilter(v as DimensionFilter)}
          />
          <FilterChipGroup
            label="scope"
            value={scopeFilter}
            options={["all", ...SCOPE_OPTIONS]}
            onChange={(v) => setScopeFilter(v as ScopeFilter)}
          />
          <FilterChipGroup
            label="conflicts"
            value={conflictFilter}
            options={["any", "has_conflict"]}
            onChange={(v) => setConflictFilter(v as ConflictFilter)}
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
            <div className="p-8 font-mono text-sm text-ink-500">No memories match the current filters.</div>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead className="bg-beige-100 sticky top-0">
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
                    className={`border-t border-beige-200 hover:bg-beige-50 cursor-pointer ${
                      selectedRow?.object_id === row.object_id ? "bg-beige-100" : ""
                    }`}
                    onClick={() => selectRow(row)}
                  >
                    <td className="px-3 py-2 truncate max-w-xs">{row.object_id.slice(0, 8)}…</td>
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
        </main>

        {selectedRow !== null && (
          <aside className="w-96 border-l border-beige-300 bg-beige-50 overflow-auto">
            <div className="px-4 py-3 flex items-center justify-between border-b border-beige-300">
              <h2 className="font-mono uppercase text-xs tracking-widest text-ink-700">Evidence</h2>
              <button
                type="button"
                onClick={() => {
                  setSelectedRow(null);
                  setPointer(null);
                }}
                className="p-1 hover:bg-beige-200"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <div className="p-4 text-xs font-mono space-y-3">
              <div>
                <div className="text-ink-500 uppercase tracking-widest text-[10px]">memory id</div>
                <div className="break-all">{selectedRow.object_id}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-widest text-[10px]">distilled content</div>
                <div className="whitespace-pre-wrap">{selectedRow.content}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-widest text-[10px]">evidence refs</div>
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
              {pointerLoading && (
                <div className="text-ink-500">Loading evidence capsule...</div>
              )}
              {pointer !== null && (
                <>
                  <div>
                    <div className="text-ink-500 uppercase tracking-widest text-[10px]">evidence object kind</div>
                    <div>{pointer.object_kind}</div>
                  </div>
                  {pointer.gist !== undefined && pointer.gist !== null && (
                    <div>
                      <div className="text-ink-500 uppercase tracking-widest text-[10px]">gist</div>
                      <div className="whitespace-pre-wrap">{pointer.gist}</div>
                    </div>
                  )}
                  {pointer.excerpt !== undefined && pointer.excerpt !== null && (
                    <div>
                      <div className="text-ink-500 uppercase tracking-widest text-[10px]">excerpt</div>
                      <div className="whitespace-pre-wrap">{pointer.excerpt}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
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
