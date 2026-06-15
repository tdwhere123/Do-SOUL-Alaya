import { useCallback, useState, useMemo } from "react";
import { RefreshCcw } from "lucide-react";
import { apiFetch, getWorkspaceId } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useI18n } from "../i18n/Locale";
import { useToasts } from "../components/Toast";

interface HealthIssueGroupRow {
  readonly group_id: string;
  readonly workspace_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly cause_kind: HealthIssueCauseKind;
  readonly severity: HealthIssueSeverity;
  readonly confidence: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly count: number;
  readonly suggested_actions: readonly string[];
  readonly resolution_state: HealthIssueResolutionState;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
}

interface HealthInboxEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly workspace_id: string;
    readonly groups: readonly HealthIssueGroupRow[];
    readonly total_count: number;
  };
}

type HealthIssueCauseKind =
  | "orphan_radar"
  | "green_revoked"
  | "evidence_failure"
  | "path_relation_failure";
type HealthIssueSeverity = "info" | "warn" | "blocking";
type HealthIssueResolutionState = "pending" | "resolved" | "suppressed";

type StateFilter = "all" | HealthIssueResolutionState;
type CauseFilter = "all" | HealthIssueCauseKind;

const STATE_OPTIONS: ReadonlyArray<StateFilter> = [
  "all",
  "pending",
  "resolved",
  "suppressed"
];

const CAUSE_OPTIONS: ReadonlyArray<CauseFilter> = [
  "all",
  "orphan_radar",
  "green_revoked",
  "evidence_failure",
  "path_relation_failure"
];

const SEVERITY_BADGE: Readonly<Record<HealthIssueSeverity, string>> = {
  blocking: "bg-state-error/15 text-state-error border-state-error/40",
  warn: "bg-state-warning/15 text-state-warning border-state-warning/40",
  info: "bg-beige-200 text-ink-600 border-beige-300"
};

/**
 * HealthInboxPage lists grouped health projections from the daemon so
 * operators can inspect unresolved evidence and path-relation issues.
 */
export default function HealthInboxPage() {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId();
  const [refreshing, setRefreshing] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>("pending");
  const [causeFilter, setCauseFilter] = useState<CauseFilter>("all");

  const fetchGroups = useCallback(async (signal: AbortSignal) => {
    const search = new URLSearchParams();
    if (stateFilter !== "all") search.set("state", stateFilter);
    if (causeFilter !== "all") search.set("causeKind", causeFilter);
    const query = search.toString();
    const envelope = await apiFetch<HealthInboxEnvelope>(
      `/workspaces/${workspaceId}/health-inbox${query.length > 0 ? `?${query}` : ""}`,
      { signal }
    );
    return envelope.data.groups;
  }, [causeFilter, stateFilter, workspaceId]);

  const { data: groupsData, error, loading, refetch } = useApiQuery(
    fetchGroups,
    [workspaceId, stateFilter, causeFilter],
    {
    enabled: workspaceId !== null,
    onError: (message) => {
      showToast({ message: `Health inbox fetch failed: ${message}`, type: "error" });
    }
    }
  );
  const groups = groupsData ?? [];

  const groupedByCause = useMemo(() => {
    const grouped = new Map<HealthIssueCauseKind, HealthIssueGroupRow[]>();
    for (const row of groups) {
      const bucket = grouped.get(row.cause_kind);
      if (bucket === undefined) {
        grouped.set(row.cause_kind, [row]);
      } else {
        bucket.push(row);
      }
    }
    return Array.from(grouped.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  }, [groups]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch("background");
    setRefreshing(false);
  }, [refetch]);

  if (workspaceId === null) {
    return <div className="p-8 font-mono text-sm text-ink-600">{t("common:noWorkspace")}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-beige-300 bg-beige-50 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-mono uppercase tracking-widest text-ink-700">
            {t("healthInbox:title")}
          </h1>
          <button
            type="button"
            className="flex items-center gap-2 border border-beige-300 px-3 py-1.5 text-xs font-mono uppercase hover:bg-beige-100 disabled:opacity-50"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
            aria-label={t("common:refresh.aria")}
          >
            <RefreshCcw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            {t("common:refresh")}
          </button>
        </div>
        <p className="mt-2 font-mono text-xs text-ink-500">{t("healthInbox:subtitle")}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <FilterChipGroup
            label={t("healthInbox:filter.state")}
            value={stateFilter}
            options={STATE_OPTIONS}
            onChange={(next) => setStateFilter(next as StateFilter)}
          />
          <FilterChipGroup
            label={t("healthInbox:filter.causeKind")}
            value={causeFilter}
            options={CAUSE_OPTIONS}
            onChange={(next) => setCauseFilter(next as CauseFilter)}
            renderOptionLabel={(option) =>
              option === "all" ? option : t(`healthInbox:cause.${option}` as never)
            }
          />
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 font-mono text-sm text-ink-500">{t("common:loading")}</div>
        ) : error !== null ? (
          <div className="p-8 font-mono text-sm text-red-600">
            {t("common:error")}: {error}
          </div>
        ) : groups.length === 0 ? (
          <div className="p-8 font-mono text-sm text-ink-500">{t("healthInbox:empty")}</div>
        ) : (
          <ul className="divide-y divide-beige-200" data-testid="health-inbox-groups">
            {groupedByCause.map(([cause, rows]) => (
              <li key={cause} className="p-4">
                <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-ink-500">
                  {t(`healthInbox:cause.${cause}` as never)} · {rows.length}
                </h2>
                <ul className="space-y-3">
                  {rows.map((row) => (
                    <HealthIssueGroupCard key={row.group_id} row={row} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function HealthIssueGroupCard({ row }: { readonly row: HealthIssueGroupRow }) {
  const { t } = useI18n();
  return (
    <li
      data-testid="health-inbox-group"
      className="rounded border border-beige-300 bg-beige-50 p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-mono uppercase ${
            SEVERITY_BADGE[row.severity]
          }`}
        >
          {row.severity}
        </span>
        <span className="font-mono text-[10px] text-ink-500">
          {t("healthInbox:row.lastSeen", { ts: row.last_seen_at })}
        </span>
      </div>
      <div className="mb-1 break-all font-mono text-xs text-ink-600">
        {row.target_object_kind} · {row.target_object_id}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-ink-700">
        <div>
          <span className="text-ink-500">{t("healthInbox:row.count")}: </span>
          {row.count}
        </div>
        <div>
          <span className="text-ink-500">{t("healthInbox:row.confidence")}: </span>
          {row.confidence.toFixed(2)}
        </div>
        <div>
          <span className="text-ink-500">{t("healthInbox:row.resolutionState")}: </span>
          {row.resolution_state}
        </div>
        <div>
          <span className="text-ink-500">{t("healthInbox:row.firstSeen")}: </span>
          {row.first_seen_at}
        </div>
      </div>
      {row.suggested_actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-ink-500">
            {t("healthInbox:row.suggestedActions")}:
          </span>
          {row.suggested_actions.map((action) => (
            <span
              key={action}
              className="border border-beige-300 bg-beige-100 px-1.5 py-0.5 text-[10px] font-mono text-ink-600"
            >
              {action}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function FilterChipGroup(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (next: string) => void;
  readonly renderOptionLabel?: (option: string) => string;
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
          {props.renderOptionLabel?.(option) ?? option}
        </button>
      ))}
    </div>
  );
}
