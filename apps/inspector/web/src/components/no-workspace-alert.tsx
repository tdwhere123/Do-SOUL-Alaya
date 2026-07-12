import { useI18n } from "../i18n/locale";

export default function NoWorkspaceAlert({ testId }: { readonly testId: string }) {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex-1 min-h-0 flex items-center justify-center bg-beige-100 p-8"
    >
      <p className="font-mono text-sm text-ink-700">
        {t("common:noWorkspace")}
      </p>
    </div>
  );
}
