import type { RecallRoutingKeyProjection } from "../runtime/routing-key-projection-port.js";
import {
  normalizeSelectedSliceKeysV2,
  type SelectedSliceKeyInputV2,
  type SelectedSliceKeyV2
} from "./slice-key-contract.js";
import { deriveSliceTimeBucketValuesV2 } from "./slice-key-selector.js";

interface DeriveProjectedRoutingKeysInput {
  readonly workspaceId: string;
  readonly projection: Readonly<RecallRoutingKeyProjection>;
  readonly asOfMs: number;
}

export function projectedRoutingKeyOwnerIdentity(ownerKind: string, ownerId: string): string {
  return JSON.stringify([ownerKind, ownerId]);
}

export function deriveProjectedRoutingKeysV2(
  input: DeriveProjectedRoutingKeysInput
): readonly SelectedSliceKeyV2[] {
  return normalizeSelectedSliceKeysV2([
    ...entityInputs(input),
    ...preferenceInputs(input),
    ...semanticInputs(input),
    ...temporalInputs(input)
  ]);
}

function entityInputs(
  input: DeriveProjectedRoutingKeysInput
): readonly SelectedSliceKeyInputV2[] {
  return input.projection.proposed_entities.map((entity) =>
    projectedInput(input, "entity", entity, "signal_entity", `entity:${entity}`)
  );
}

function preferenceInputs(
  input: DeriveProjectedRoutingKeysInput
): readonly SelectedSliceKeyInputV2[] {
  return Object.entries(input.projection.proposed_preference).flatMap(([field, value]) =>
    value === null
      ? []
      : [projectedInput(
          input,
          `preference_${field}`,
          value,
          "signal_preference",
          `preference:${field}`
        )]
  );
}

function semanticInputs(
  input: DeriveProjectedRoutingKeysInput
): readonly SelectedSliceKeyInputV2[] {
  const fact = input.projection.proposed_fact;
  return fact === null
    ? []
    : [projectedInput(input, "semantic", fact, "signal_fact", "distilled-fact")];
}

function temporalInputs(
  input: DeriveProjectedRoutingKeysInput
): readonly SelectedSliceKeyInputV2[] {
  return deriveSliceTimeBucketValuesV2(
    input.projection.temporal.start,
    input.projection.temporal.end
  ).map((bucket) =>
    projectedInput(input, "time", bucket, "signal_time", `event-time:${bucket}`)
  );
}

function projectedInput(
  input: DeriveProjectedRoutingKeysInput,
  dimension: string,
  value: string,
  kind: SelectedSliceKeyInputV2["provenance"]["kind"],
  sourceSuffix: string
): SelectedSliceKeyInputV2 {
  const projection = input.projection;
  return {
    workspace_id: input.workspaceId,
    owner_id: projection.owner_id,
    dimension,
    value,
    authority: "proposed_routing_only",
    reliability: projection.reliability,
    independence_group: projection.independence_group,
    provenance: {
      kind,
      source_ref: `signal:${projection.source_signal_id}:${sourceSuffix}`
    },
    source_version: projection.source_version,
    freshness: { state: "fresh", as_of_ms: input.asOfMs }
  };
}
