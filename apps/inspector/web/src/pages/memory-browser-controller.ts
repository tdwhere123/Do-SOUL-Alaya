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
import type { ToastInput } from "../components/Toast";
import { useApiQuery } from "../hooks/useApiQuery";
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
  readonly promoteBusyId: string | null;
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
  const isMountedRef = useMountedRef();
  const filters = useMemoryFilterState();
  const pointer = useEvidencePointer({ workspaceId, showToast, isMountedRef });
  const rows = useMemoryRows({ workspaceId, showToast, filters, isMountedRef });
  const selection = useMemorySelection(rows.rows, pointer.invalidatePointerState);
  const promotion = useStrictGovernancePromotion({ workspaceId, showToast, isMountedRef });
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
    promoteBusyId: promotion.promoteBusyId,
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
}) {
  const [rowState, setRowState] = useState(() => emptyRowState());
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const queryVersionRef = useRef(0);
  const firstPage = useFirstMemoryPage(props.workspaceId, props.filters, props.showToast);
  useMemoryRowLifecycle({
    firstPage: firstPage.data,
    filters: props.filters,
    queryVersionRef,
    setLoadingMore,
    setRowState,
    workspaceId: props.workspaceId
  });

  const handleRefresh = useCallback(async () => {
    queryVersionRef.current += 1;
    setLoadingMore(false);
    setRefreshing(true);
    await firstPage.refetch("background");
    if (props.isMountedRef.current) {
      setRefreshing(false);
    }
  }, [firstPage, props.isMountedRef]);

  const loadMore = useLoadMoreRows({
    ...props,
    nextOffset: rowState.nextOffset,
    queryVersionRef,
    refreshing,
    setLoadingMore,
    setRowState
  });

  return {
    ...rowState,
    error: firstPage.error,
    loading: firstPage.loading,
    loadingMore,
    paginationStatus: formatPaginationStatus(rowState),
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
  showToast: ShowToast
) {
  const fetchRows = useCallback(
    (signal: AbortSignal) =>
      workspaceId === null ? Promise.resolve(emptyRowState()) : fetchMemoryPage(workspaceId, filters, 0, signal),
    [filters, workspaceId]
  );
  return useApiQuery(fetchRows, [workspaceId, filters], {
    enabled: workspaceId !== null,
    onError: (message) => {
      showToast({ message: `Memory list fetch failed: ${message}`, type: "error" });
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
}) {
  return useCallback(async () => {
    if (props.workspaceId === null || props.refreshing) return;
    const version = props.queryVersionRef.current;
    props.setLoadingMore(true);
    try {
      const page = await fetchMemoryPage(props.workspaceId, props.filters, props.nextOffset);
      if (!props.isMountedRef.current || version !== props.queryVersionRef.current) return;
      props.setRowState((previous) => appendRowPage(previous, page));
    } catch (err) {
      if ((err as ApiError).status !== 401) {
        const message = err instanceof Error ? err.message : "unknown error";
        props.showToast({ message: `Memory list fetch failed: ${message}`, type: "error" });
      }
    } finally {
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
        const message = err instanceof Error ? err.message : "unknown error";
        props.showToast({ message: `Evidence open failed: ${message}`, type: "error" });
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
}) {
  const [promoteBusyId, setPromoteBusyId] = useState<string | null>(null);
  const promoteToStrictlyGoverned = useCallback(async (memoryId: string) => {
    if (props.workspaceId === null) return;
    setPromoteBusyId(memoryId);
    try {
      const envelope = await apiFetch<PromoteEnvelope>(
        `/workspaces/${props.workspaceId}/soul/memory/${encodeURIComponent(memoryId)}/proposals/promote-strictly-governed`,
        { method: "POST", body: {} }
      );
      props.showToast({
        type: "success",
        message: `Proposal created: ${envelope.data.proposal_id} (path_relation → strictly_governed)`
      });
    } catch (err) {
      if ((err as ApiError).status !== 401) {
        const message = err instanceof Error ? err.message : "unknown error";
        props.showToast({ message: `Promote failed: ${message}`, type: "error" });
      }
    } finally {
      if (props.isMountedRef.current) {
        setPromoteBusyId(null);
      }
    }
  }, [props]);
  return { promoteBusyId, promoteToStrictlyGoverned };
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

function formatPaginationStatus(rowState: MemoryPageData): string {
  const droppedLoadedRows = Math.max(0, rowState.nextOffset - rowState.rows.length);
  if (droppedLoadedRows === 0) {
    return `Showing ${rowState.rows.length}${rowState.totalRows === null ? "" : ` of ${rowState.totalRows}`} loaded`;
  }
  return `Showing ${rowState.rows.length} retained window of ${rowState.nextOffset}${
    rowState.totalRows === null ? "" : ` of ${rowState.totalRows}`
  } loaded`;
}
