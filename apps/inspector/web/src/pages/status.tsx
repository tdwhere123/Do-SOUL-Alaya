import type { AlayaStatus } from "@do-soul/alaya-protocol";
import { useDaemonHealth } from "../hooks/useDaemonHealth";
import { useI18n } from "../i18n/locale";
import { StatusLoadingView, StatusPageShell } from "./status-sections";

export default function StatusPage() {
  const { t } = useI18n();
  const health = useDaemonHealth();
  const status = statusFromHealthState(health.state);
  const loading = health.state.kind === "loading";

  if (loading && !status) return <StatusLoadingView />;
  return (
    <StatusPageShell
      degraded={health.state.kind === "degraded" ? health.state.message : null}
      indicator={health.indicator}
      refreshing={health.refreshing}
      schemaMismatch={health.state.kind === "schema_error"}
      status={status}
      t={t}
      onRefresh={() => void health.refresh()}
    />
  );
}

function statusFromHealthState(state: ReturnType<typeof useDaemonHealth>["state"]): AlayaStatus | null {
  if (state.kind === "ok") return state.status;
  if (state.kind === "degraded") return state.lastStatus;
  return null;
}
