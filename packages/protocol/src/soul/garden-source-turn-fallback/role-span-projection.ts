import type { GardenSourceTurnFallbackV2Receipt } from "../garden-source-turn-fallback-receipt.js";

export function projectGardenSourceTurnFallbackV2UserContent(
  receipt: Readonly<GardenSourceTurnFallbackV2Receipt>
): string {
  return projectRoleContents(receipt, "user").join("\n");
}

export function projectGardenSourceTurnFallbackV2AssistantObservations(
  receipt: Readonly<GardenSourceTurnFallbackV2Receipt>
): readonly string[] {
  return Object.freeze(projectRoleContents(receipt, "assistant"));
}

function projectRoleContents(
  receipt: Readonly<GardenSourceTurnFallbackV2Receipt>,
  role: GardenSourceTurnFallbackV2Receipt["source_role_spans"][number]["role"]
): string[] {
  return receipt.source_role_spans
    .filter((span) => span.role === role)
    .map((span) => receipt.source_corpus.slice(span.start, span.end));
}
