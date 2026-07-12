import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import { apiFetch, type ApiError } from "../api";
import type { ToastInput } from "../components/toast";
import { useApiQuery } from "../hooks/useApiQuery";
import { useI18n } from "../i18n/locale";
import { fetchMemoryPage, type MemoryFilterState } from "./memory-browser-api";
import {
  retainLoadedMemoryRowWindow,
  type ConflictFilter,
  type DimensionFilter,
  type EvidenceCapsuleShape,
  type EvidenceEnvelope,
  type MemoryEntryRow,
  type MemoryPageData,
  type PromoteEnvelope,
  type ScopeFilter
} from "./memory-browser-support";

type ShowToast = (input: ToastInput) => void;
type Translate = ReturnType<typeof useI18n>["t"];

interface ControllerOptions {
  readonly workspaceId: string | null;
  readonly showToast: ShowToast;
}

export interface MemoryBrowserController {
  readonly conflictFilter: ConflictFilter;
  readonly dimensionFilter: DimensionFilter;
  readonly error: string | null;
  readonly hasMoreRows: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly paginationStatus: string;
  readonly pointer: EvidenceCapsuleShape | null;
  readonly pointerLoading: boolean;
  readonly promoteBusyIds: ReadonlySet<string>;
  readonly refreshing: boolean;
  readonly rows: readonly MemoryEntryRow[];
  readonly scopeFilter: ScopeFilter;
  readonly selectedRow: MemoryEntryRow | null;
  readonly closeSelection: () => void;
  readonly handleRefresh: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
  readonly openEvidence: (evidenceId: string) => Promise<void>;
  readonly promoteToStrictlyGoverned: (memoryId: string) => Promise<void>;
  readonly selectRow: (row: MemoryEntryRow) => void;
  readonly setConflictFilter: (value: ConflictFilter) => void;
  readonly setDimensionFilter: (value: DimensionFilter) => void;
  readonly setScopeFilter: (value: ScopeFilter) => void;
}

export function useMemoryBrowserController({
  workspaceId,
  showToast
}: ControllerOptions): MemoryBrowserController {
  const { t } = useI18n();
  const isMountedRef = useMountedRef();
  const filters = useMemoryFilterState();
  const pointer = useEvidencePointer({ workspaceId, showToast, isMountedRef, t });
  const rows = useMemoryRows({ workspaceId, showToast, filters, isMountedRef, t });
  const selection = useMemorySelection(rows.rows, pointer.invalidatePointerState);
  const promotion = useStrictGovernancePromotion({ workspaceId, showToast, isMountedRef, t });
  const handleRefresh = useCallback(async () => {
    pointer.invalidatePointerState();
    await rows.handleRefresh();
  }, [pointer.invalidatePointerState, rows.handleRefresh]);

  return {
    ...filters,
    ...rows,
    ...selection,
    handleRefresh,
    pointer: pointer.pointer,
    pointerLoading: pointer.pointerLoading,
    openEvidence: pointer.openEvidence,
    promoteBusyIds: promotion.promoteBusyIds,
    promoteToStrictlyGoverned: promotion.promoteToStrictlyGoverned
  };
}

function useMountedRef(): MutableRefObject<boolean> {
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  return isMountedRef;
}

function useMemoryFilterState(): MemoryFilterState & {
  readonly setConflictFilter: (value: ConflictFilter) => void;
  readonly setDimensionFilter: (value: DimensionFilter) => void;
  readonly setScopeFilter: (value: ScopeFilter) => void;
} {
  const [dimensionFilter, setDimensionFilter] = useState<DimensionFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [conflictFilter, setConflictFilter] = useState<ConflictFilter>("any");
  return useMemo(
    () => ({
      conflictFilter,
      dimensionFilter,
      scopeFilter,
      setConflictFilter,
      setDimensionFilter,
      setScopeFilter
    }),
    [conflictFilter, dimensionFilter, scopeFilter]
  );
}

function useMemoryRows(props: {
  readonly workspaceId: string | null;
  readonly showToast: ShowToast;
  readonly filters: MemoryFilterState;
  readonly isMountedRef: MutableRefObject<boolean>;
  readonly t: Translate;
}) {
  const [rowState, setRowState] = useState(() => emptyRowState());
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const queryVersionRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const firstPage = useFirstMemoryPage(props.workspaceId, props.filters, props.showToast, props.t);
  useMemoryRowLifecycle({
    firstPage: firstPage.data,
    filters: props.filters,
    queryVersionRef,
    setLoadingMore,
    setRowState,
    workspaceId: props.workspaceId
  });

  const handleRefresh = useCallback(async () => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    queryVersionRef.current += 1;
    setLoadingMore(false);
    setRefreshing(true);
    await firstPage.refetch("background");
    if (props.isMountedRef.current) {
      setRefreshing(false);
    }
  }, [firstPage, props.isMountedRef]);

  useEffect(() => () => loadMoreAbortRef.current?.abort(), []);

  const loadMore = useLoadMoreRows({
    ...props,
    nextOffset: rowState.nextOffset,
    queryVersionRef,
    refreshing,
    setLoadingMore,
    setRowState,
    loadMoreAbortRef
  });

  return {
    ...rowState,
    error: firstPage.error,
    loading: firstPage.loading,
    loadingMore,
    paginationStatus: formatPaginationStatus(rowState, props.t),
    refreshing,
    handleRefresh,
    loadMore
  };
}

function useMemoryRowLifecycle(props: {
  readonly firstPage: MemoryPageData | null;
  readonly filters: MemoryFilterState;
  readonly queryVersionRef: MutableRefObject<number>;
  readonly setLoadingMore: (loading: boolean) => void;
  readonly setRowState: Dispatch<SetStateAction<MemoryPageData>>;
  readonly workspaceId: string | null;
}) {
  useEffect(() => {
    props.queryVersionRef.current += 1;
    props.setLoadingMore(false);
    props.setRowState(emptyRowState());
  }, [props.filters, props.workspaceId]);

  useEffect(() => {
    if (props.firstPage) {
      props.setRowState(rowStateFromPage(props.firstPage));
    }
  }, [props.firstPage]);
}

function useFirstMemoryPage(
  workspaceId: string | null,
  filters: MemoryFilterState,
  showToast: ShowToast,
  t: Translate
) {
  const fetchRows = useCallback(
    (signal: AbortSignal) =>
      workspaceId === null ? Promise.resolve(emptyRowState()) : fetchMemoryPage(workspaceId, filters, 0, signal),
    [filters, workspaceId]
  );
  return useApiQuery(fetchRows, [workspaceId, filters], {
    enabled: workspaceId !== null,
    onError: (message) => {
      showToast({ message: t("memoryBrowser:toast.memoryListFetchFailed", { message }), type: "error" });
    }
  });
}

function useLoadMoreRows(props: {
  readonly workspaceId: string | null;
  readonly showToast: ShowToast;
  readonly filters: MemoryFilterState;
  readonly isMountedRef: MutableRefObject<boolean>;
  readonly nextOffset: number;
  readonly queryVersionRef: MutableRefObject<number>;
  readonly refreshing: boolean;
  readonly setLoadingMore: (loading: boolean) => void;
  readonly setRowState: Dispatch<SetStateAction<MemoryPageData>>;
  readonly loadMoreAbortRef: MutableRefObject<AbortController | null>;
  readonly t: Translate;
}) {
  return useCallback(async () => {
    if (props.workspaceId === null || props.refreshing) return;
    const version = props.queryVersionRef.current;
    const controller = new AbortController();
    props.loadMoreAbortRef.current?.abort();
    props.loadMoreAbortRef.current = controller;
    props.setLoadingMore(true);
    try {
      const page = await fetchMemoryPage(props.workspaceId, props.filters, props.nextOffset, controller.signal);
      if (!props.isMountedRef.current || version !== props.queryVersionRef.current) return;
      props.setRowState((previous) => appendRowPage(previous, page));
    } catch (err) {
      if (
        controller.signal.aborted ||
        !props.isMountedRef.current ||
        version !== props.queryVersionRef.current
      ) {
        return;
      }
      if ((err as ApiError).status !== 401) {
        const message = err instanceof Error ? err.message : props.t("memoryBrowser:error.unknown");
        props.showToast({
          message: props.t("memoryBrowser:toast.memoryListFetchFailed", { message }),
          type: "error"
        });
      }
    } finally {
      if (props.loadMoreAbortRef.current === controller) {
        props.loadMoreAbortRef.current = null;
      }
      if (props.isMountedRef.current && version === props.queryVersionRef.current) {
        props.setLoadingMore(false);
      }
    }
  }, [props]);
}

function useMemorySelection(
  rows: readonly MemoryEntryRow[],
  invalidatePointerState: () => void
) {
  const [selectedRow, setSelectedRow] = useState<MemoryEntryRow | null>(null);
  const closeSelection = useCallback(() => {
    setSelectedRow(null);
    invalidatePointerState();
  }, [invalidatePointerState]);
  const selectRow = useCallback((row: MemoryEntryRow) => {
    setSelectedRow(row);
    invalidatePointerState();
  }, [invalidatePointerState]);

  useEffect(() => {
    if (selectedRow === null) return;
    const replacement = rows.find((row) => row.object_id === selectedRow.object_id) ?? null;
    if (replacement === null) {
      closeSelection();
    } else if (replacement !== selectedRow) {
      setSelectedRow(replacement);
      invalidatePointerState();
    }
  }, [closeSelection, invalidatePointerState, rows, selectedRow]);

  return { selectedRow, closeSelection, selectRow };
}

function useEvidencePointer(props: {
  readonly workspaceId: string | null;
  readonly showToast: ShowToast;
  readonly isMountedRef: MutableRefObject<boolean>;
  readonly t: Translate;
}) {
  const pointerVersionRef = useRef(0);
  const [pointer, setPointer] = useState<EvidenceCapsuleShape | null>(null);
  const [pointerLoading, setPointerLoading] = useState(false);
  const invalidatePointerState = useCallback(() => {
    pointerVersionRef.current += 1;
    setPointer(null);
    setPointerLoading(false);
  }, []);
  const openEvidence = useOpenEvidence({ ...props, pointerVersionRef, setPointer, setPointerLoading });
  return { invalidatePointerState, openEvidence, pointer, pointerLoading };
}

function useOpenEvidence(props: {
  readonly workspaceId: string | null;
  readonly showToast: ShowToast;
  readonly isMountedRef: MutableRefObject<boolean>;
  readonly pointerVersionRef: MutableRefObject<number>;
  readonly setPointer: (pointer: EvidenceCapsuleShape | null) => void;
  readonly setPointerLoading: (loading: boolean) => void;
  readonly t: Translate;
}) {
  return useCallback(async (evidenceId: string) => {
    if (props.workspaceId === null) return;
    const pointerVersion = ++props.pointerVersionRef.current;
    props.setPointerLoading(true);
    props.setPointer(null);
    try {
      const envelope = await apiFetch<EvidenceEnvelope>(
        `/pointers/${props.workspaceId}/${encodeURIComponent(evidenceId)}`
      );
      if (!props.isMountedRef.current || pointerVersion !== props.pointerVersionRef.current) return;
      props.setPointer(envelope.data);
    } catch (err) {
      if (props.isMountedRef.current && pointerVersion === props.pointerVersionRef.current) {
        const message = err instanceof Error ? err.message : props.t("memoryBrowser:error.unknown");
        props.showToast({
          message: props.t("memoryBrowser:toast.evidenceOpenFailed", { message }),
          type: "error"
        });
      }
    } finally {
      if (props.isMountedRef.current && pointerVersion === props.pointerVersionRef.current) {
        props.setPointerLoading(false);
      }
    }
  }, [props]);
}

function useStrictGovernancePromotion(props: {
  readonly workspaceId: string | null;
  readonly showToast: ShowToast;
  readonly isMountedRef: MutableRefObject<boolean>;
  readonly t: Translate;
}) {
  const [promoteBusyIds, setPromoteBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const promoteToStrictlyGoverned = useCallback(async (memoryId: string) => {
    if (props.workspaceId === null) return;
    setPromoteBusyIds((previous) => new Set(previous).add(memoryId));
    try {
      const envelope = await apiFetch<PromoteEnvelope>(
        `/workspaces/${props.workspaceId}/soul/memory/${encodeURIComponent(memoryId)}/proposals/promote-strictly-governed`,
        { method: "POST", body: {} }
      );
      props.showToast({
        type: "success",
        message: props.t("memoryBrowser:toast.proposalCreated", { id: envelope.data.proposal_id })
      });
    } catch (err) {
      if ((err as ApiError).status !== 401) {
        const message = err instanceof Error ? err.message : props.t("memoryBrowser:error.unknown");
        props.showToast({
          message: props.t("memoryBrowser:toast.promoteFailed", { message }),
          type: "error"
        });
      }
    } finally {
      if (props.isMountedRef.current) {
        setPromoteBusyIds((previous) => {
          const next = new Set(previous);
          next.delete(memoryId);
          return next;
        });
      }
    }
  }, [props]);
  return { promoteBusyIds, promoteToStrictlyGoverned };
}

function emptyRowState(): MemoryPageData {
  return { rows: [], totalRows: null, nextOffset: 0, hasMoreRows: false };
}

function rowStateFromPage(page: MemoryPageData): MemoryPageData {
  return { ...page, rows: retainLoadedMemoryRowWindow([], page.rows) };
}

function appendRowPage(previous: MemoryPageData, page: MemoryPageData): MemoryPageData {
  return {
    rows: retainLoadedMemoryRowWindow(previous.rows, page.rows),
    totalRows: page.totalRows,
    nextOffset: page.nextOffset,
    hasMoreRows: page.hasMoreRows
  };
}

function formatPaginationStatus(rowState: MemoryPageData, t: Translate): string {
  const droppedLoadedRows = Math.max(0, rowState.nextOffset - rowState.rows.length);
  if (droppedLoadedRows === 0) {
    return rowState.totalRows === null
      ? t("memoryBrowser:pagination.showing", { count: rowState.rows.length })
      : t("memoryBrowser:pagination.showingTotal", {
          count: rowState.rows.length,
          total: rowState.totalRows
        });
  }
  return rowState.totalRows === null
    ? t("memoryBrowser:pagination.retained", {
        count: rowState.rows.length,
        offset: rowState.nextOffset
      })
    : t("memoryBrowser:pagination.retainedTotal", {
        count: rowState.rows.length,
        offset: rowState.nextOffset,
        total: rowState.totalRows
      });
}
