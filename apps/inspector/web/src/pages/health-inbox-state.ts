import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useToasts } from "../components/Toast";
import type {
  CauseFilter,
  HealthInboxEnvelope,
  HealthIssueCauseKind,
  HealthIssueGroupRow,
  StateFilter
} from "./health-inbox-types";

export interface HealthInboxState {
  readonly causeFilter: CauseFilter;
  readonly error: string | null;
  readonly groupedByCause: ReadonlyArray<readonly [HealthIssueCauseKind, readonly HealthIssueGroupRow[]]>;
  readonly groups: readonly HealthIssueGroupRow[];
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly stateFilter: StateFilter;
  readonly refresh: () => Promise<void>;
  readonly setCauseFilter: (filter: CauseFilter) => void;
  readonly setStateFilter: (filter: StateFilter) => void;
}

export function useHealthInboxState(workspaceId: string | null): HealthInboxState {
  const { showToast } = useToasts();
  const [refreshing, setRefreshing] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>("pending");
  const [causeFilter, setCauseFilter] = useState<CauseFilter>("all");
  const fetchGroups = useHealthInboxFetcher(workspaceId, stateFilter, causeFilter);
  const { data, error, loading, refetch } = useApiQuery(fetchGroups, [
    workspaceId,
    stateFilter,
    causeFilter
  ], {
    enabled: workspaceId !== null,
    onError: (message) => {
      showToast({ message: `Health inbox fetch failed: ${message}`, type: "error" });
    }
  });
  const groups = data ?? [];
  return {
    causeFilter,
    error,
    groupedByCause: useGroupedHealthIssues(groups),
    groups,
    loading,
    refreshing,
    stateFilter,
    refresh: useRefreshHealthInbox(refetch, setRefreshing),
    setCauseFilter,
    setStateFilter
  };
}

function useHealthInboxFetcher(
  workspaceId: string | null,
  stateFilter: StateFilter,
  causeFilter: CauseFilter
) {
  return useCallback(async (signal: AbortSignal) => {
    const query = healthInboxQuery(stateFilter, causeFilter);
    const envelope = await apiFetch<HealthInboxEnvelope>(
      `/workspaces/${workspaceId}/health-inbox${query}`,
      { signal }
    );
    return envelope.data.groups;
  }, [causeFilter, stateFilter, workspaceId]);
}

function useGroupedHealthIssues(groups: readonly HealthIssueGroupRow[]) {
  return useMemo(() => {
    const grouped = new Map<HealthIssueCauseKind, HealthIssueGroupRow[]>();
    for (const row of groups) {
      grouped.set(row.cause_kind, [...(grouped.get(row.cause_kind) ?? []), row]);
    }
    return Array.from(grouped.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  }, [groups]);
}

function useRefreshHealthInbox(
  refetch: (mode?: "replace" | "background") => Promise<readonly HealthIssueGroupRow[] | null>,
  setRefreshing: (refreshing: boolean) => void
) {
  return useCallback(async () => {
    setRefreshing(true);
    await refetch("background");
    setRefreshing(false);
  }, [refetch, setRefreshing]);
}

function healthInboxQuery(stateFilter: StateFilter, causeFilter: CauseFilter): string {
  const search = new URLSearchParams();
  if (stateFilter !== "all") search.set("state", stateFilter);
  if (causeFilter !== "all") search.set("causeKind", causeFilter);
  const query = search.toString();
  return query.length > 0 ? `?${query}` : "";
}
