import { getWorkspaceId } from "../api";
import { useToasts } from "../components/toast";
import { useI18n } from "../i18n/locale";
import { useMemoryBrowserController } from "./memory-browser-controller";
import { MemoryBrowserPageView } from "./memory-browser-view";

export { retainLoadedMemoryRowWindow } from "./memory-browser-support";

/**
 * MemoryBrowserPage lists memory entries with daemon-authoritative filters,
 * paginated reads, and evidence drill-in from the side panel.
 */
export default function MemoryBrowserPage() {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId();
  const controller = useMemoryBrowserController({ workspaceId, showToast });

  if (workspaceId === null) {
    return <div className="p-8 font-mono text-sm text-ink-600">Workspace binding missing.</div>;
  }

  return (
    <MemoryBrowserPageView
      title={t("nav:memoryBrowser")}
      controller={controller}
      promoteLabel={t("healthInbox:row.promoteStrictlyGoverned")}
      promoteAriaLabel={(id) => t("healthInbox:row.promoteStrictlyGovernedAria", { id })}
    />
  );
}
