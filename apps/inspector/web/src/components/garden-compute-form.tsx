import { useI18n } from "../i18n/locale";
import {
  ReadOnlyFieldRow,
  RuntimeConfigReadOnlyNotice,
  formatSecretRef
} from "./config-form-fields";
import { LoadingConfig } from "./embedding-supplement-form";
import { useGardenComputeState } from "./garden-compute-state";

interface Props {
  readonly workspaceId: string;
}

export default function GardenComputeForm({ workspaceId }: Props) {
  const { t } = useI18n();
  const state = useGardenComputeState(workspaceId);
  if (state.loading) {
    return <LoadingConfig label={t("config:loading.gardenCompute")} />;
  }
  if (state.config === null) return null;
  return (
    <div className="space-y-5">
      <RuntimeConfigReadOnlyNotice />
      <ReadOnlyFieldRow label={t("config:field.providerKind")} value={state.config.provider_kind} />
      <ReadOnlyFieldRow label={t("config:field.providerUrl")} value={state.config.provider_url} />
      <ReadOnlyFieldRow label={t("config:field.modelId")} value={state.config.model_id} />
      <ReadOnlyFieldRow label={t("config:field.gardenComputeEnabled")} value={state.config.enabled} />
      <ReadOnlyFieldRow label={t("config:field.secretRef")} value={formatSecretRef(state.config.secret_ref)} />
    </div>
  );
}
