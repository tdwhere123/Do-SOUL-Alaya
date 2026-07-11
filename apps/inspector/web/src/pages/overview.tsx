import { getWorkspaceId } from "../api";
import { useDaemonHealth } from "../hooks/useDaemonHealth";
import { useI18n } from "../i18n/locale";
import { useOverviewData } from "./overview-data";
import {
  BenchSummarySection,
  OverviewDegradedAlert,
  OverviewHeader,
  OverviewSummaryGrid
} from "./overview-sections";

export default function OverviewPage() {
  const { t } = useI18n();
  const health = useDaemonHealth();
  const overview = useOverviewData(getWorkspaceId());
  const degradedMessage = health.state.kind === "degraded" ? health.state.message : null;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-8 font-mono">
        {degradedMessage ? <OverviewDegradedAlert message={degradedMessage} t={t} /> : null}
        <OverviewHeader
          indicator={health.indicator}
          refreshing={health.refreshing}
          onRefresh={() => void health.refresh()}
          t={t}
        />
        <OverviewSummaryGrid
          daemonState={health.state}
          pendingCount={overview.pendingCount}
          recallStats={overview.recallStats}
          t={t}
        />
        <BenchSummarySection
          benchData={overview.benchData}
          loaded={overview.benchLoaded}
          t={t}
        />
      </div>
    </div>
  );
}
