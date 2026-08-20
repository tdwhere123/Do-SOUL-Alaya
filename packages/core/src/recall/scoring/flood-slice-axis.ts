import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type {
  FloodAxisInactiveReason,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { projectedRoutingKeyOwnerIdentity } from "../flood/projected-routing-keys.js";
import {
  deriveMemorySliceKeysV2,
  selectSliceCompatibilityV2,
  type SliceCompatibilityV2
} from "../flood/slice-key-selector.js";
import {
  mergeSelectedSliceKeysV2,
  type SelectedSliceKeyV2
} from "../flood/slice-key-contract.js";

type ResolvedSliceFloodAxis = Readonly<{
  readonly value: number;
  readonly status: FloodAxisInactiveReason;
  readonly countsAsFuel: boolean;
}>;

const EMPTY_KEYS: readonly SelectedSliceKeyV2[] = Object.freeze([]);

export function resolveSliceAxis(
  entry: Readonly<MemoryEntry>,
  supplementaryData: RecallSupplementaryData
): ResolvedSliceFloodAxis {
  const memoryKeys = memorySliceKeys(entry, supplementaryData);
  return axisFromCompatibility(selectSliceCompatibilityV2({
    queryKeys: supplementaryData.queryRoutingKeys ?? EMPTY_KEYS,
    sourceKeys: memoryKeys,
    targetKeys: memoryKeys
  }));
}

function memorySliceKeys(
  entry: Readonly<MemoryEntry>,
  supplementaryData: RecallSupplementaryData
): readonly SelectedSliceKeyV2[] {
  return mergeSelectedSliceKeysV2(
    deriveMemorySliceKeysV2({
      workspaceId: entry.workspace_id,
      entry,
      asOfMs: supplementaryData.queryTimeWindow?.startMs ?? 0
    }),
    supplementaryData.routingKeysByOwnerIdentity?.get(
      projectedRoutingKeyOwnerIdentity("memory_entry", entry.object_id)
    ) ?? EMPTY_KEYS
  );
}

function axisFromCompatibility(
  compatibility: Readonly<SliceCompatibilityV2>
): ResolvedSliceFloodAxis {
  if (compatibility.decision === "compatible") {
    return { value: 1, status: "active", countsAsFuel: true };
  }
  if (compatibility.decision === "rejected") {
    return { value: 0, status: "inactive:no_slice_match", countsAsFuel: false };
  }
  return { value: 1, status: "inactive:no_slice", countsAsFuel: true };
}
