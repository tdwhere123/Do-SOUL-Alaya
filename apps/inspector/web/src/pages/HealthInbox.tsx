import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useI18n } from "../i18n/Locale";
import { useToasts } from "../components/Toast";

// invariant: HealthInbox is a read-only projection over
// HealthIssueGroup rows. The page never mutates the underlying audit
// table — actions are routed through the existing Proposals surface.
// see also: apps/core-daemon/src/routes/health-inbox.ts

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

type HealthIssueCauseKind = "orphan_radar" | "green_revoked" | "evidence_failure";
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
  "evidence_failure"
];

const SEVERITY_BADGE: Readonly<Record<HealthIssueSeverity, string>> = {
  blocking: "bg-state-error/15 text-state-error border-state-error/40",
  warn: "bg-state-warning/15 text-state-warning border-state-warning/40",
  info: "bg-beige-200 text-ink-600 border-beige-300"
};

export default function HealthInboxPage() {
  const { t } = useI18n();
  const workspaceId = getWorkspaceId();
  const [groups, setGroups] = useState<readonly HealthIssueGroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("pending");
  const [causeFilter, setCauseFilter] = useState<CauseFilter>("all");
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const { showToast } = useToasts();

  const fetchGroups = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    requestIdRef.current += 1;
    const myRequestId = requestIdRef.current;
    try {
      const search = new URLSearchParams();
      if (stateFilter !== "all") search.set("state", stateFilter);
      if (causeFilter !== "all") search.set("causeKind", causeFilter);
      const query = search.toString();
      const envelope = await apiFetch<HealthInboxEnvelope>(
        `/workspaces/${workspaceId}/health-inbox${query.length > 0 ? `?${query}` : ""}`
      );
      if (!isMountedRef.current || myRequestId !== requestIdRef.current) return;
      setGroups(envelope.data.groups);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current || myRequestId !== requestIdRef.current) return;
      if ((err as ApiError).status === 401) return;
      const message = err instanceof Error ? err.message : "unknown error";
      setError(message);
      showToast({ message: `Health inbox fetch failed: ${message}`, type: "error" });
    } finally {
      if (isMountedRef.current && myRequestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [workspaceId, stateFilter, causeFilter, showToast]);

  useEffect(() => {
    isMountedRef.current = true;
    setLoading(true);
    void fetchGroups();
    return () => {
      isMountedRef.current = false;
    };
  }, [fetchGroups]);

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
    return Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [groups]);

  if (workspaceId === null) {
    return (
      <div className="p-8 font-mono text-sm text-ink-600">
        {t("common:noWorkspace")}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 border-b border-beige-300 bg-beige-50">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-mono uppercase tracking-widest text-ink-700">
            {t("healthInbox:title")}
          </h1>
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono uppercase border border-beige-300 hover:bg-beige-100 disabled:opacity-50"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void fetchGroups();
            }}
            aria-label={t("common:refresh.aria")}
          >
            <RefreshCcw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
            {t("common:refresh")}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-500 font-mono">{t("healthInbox:subtitle")}</p>
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
          <div className="p-8 font-mono text-sm text-ink-500">
            {t("healthInbox:empty")}
          </div>
        ) : (
          <ul className="divide-y divide-beige-200" data-testid="health-inbox-groups">
            {groupedByCause.map(([cause, rows]) => (
              <li key={cause} className="p-4">
                <h2 className="font-mono text-xs uppercase tracking-widest text-ink-500 mb-2">
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
      className="border border-beige-300 rounded p-3 bg-beige-50"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span
          className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono uppercase border rounded ${
            SEVERITY_BADGE[row.severity]
          }`}
        >
          {row.severity}
        </span>
        <span className="text-[10px] font-mono text-ink-500">
          {t("healthInbox:row.lastSeen", { ts: row.last_seen_at })}
        </span>
      </div>
      <div className="font-mono text-xs text-ink-600 mb-1 break-all">
        {row.target_object_kind} · {row.target_object_id}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono text-ink-700">
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
      {row.suggested_actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-ink-500">
            {t("healthInbox:row.suggestedActions")}:
          </span>
          {row.suggested_actions.map((action) => (
            <span
              key={action}
              className="px-1.5 py-0.5 text-[10px] font-mono border border-beige-300 bg-beige-100 text-ink-600"
            >
              {action}
            </span>
          ))}
        </div>
      )}
    </li>
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
