import { getWorkspaceId } from "../api";
import { useI18n } from "../i18n/Locale";
import { ConfigNoWorkspace, ConfigPageShell } from "./config-layout";
import { useConfigPageState } from "./config-page-state";

export default function ConfigPage() {
  const workspaceId = getWorkspaceId();
  const { t } = useI18n();
  const pageState = useConfigPageState();

  if (workspaceId === null) {
    return <ConfigNoWorkspace t={t} />;
  }

  return <ConfigPageShell workspaceId={workspaceId} state={pageState} />;
}
