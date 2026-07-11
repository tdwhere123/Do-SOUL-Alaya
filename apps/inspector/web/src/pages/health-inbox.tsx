import { getWorkspaceId } from "../api";
import { useI18n } from "../i18n/locale";
import { useHealthInboxState } from "./health-inbox-state";
import { HealthInboxNoWorkspace, HealthInboxView } from "./health-inbox-view";

export default function HealthInboxPage() {
  const { t } = useI18n();
  const workspaceId = getWorkspaceId();
  const state = useHealthInboxState(workspaceId);

  if (workspaceId === null) {
    return <HealthInboxNoWorkspace text={t("common:noWorkspace")} />;
  }

  return <HealthInboxView state={state} />;
}
