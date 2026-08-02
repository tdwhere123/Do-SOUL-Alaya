import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type {
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import type { RecallRoutingKeyProjection } from "../runtime/routing-key-projection-port.js";
import {
  computeAttributedKeyActivationV1,
  type AttributedKeyActivationV1
} from "../flood/attributed-key-activation.js";
import {
  deriveProjectedRoutingKeysV2,
  projectedRoutingKeyOwnerIdentity
} from "../flood/projected-routing-keys.js";
import type { SelectedSliceKeyV2 } from "../flood/slice-key-contract.js";
import { deriveQuerySliceKeysV2 } from "../flood/slice-key-selector.js";
import { errorNameOf, toErrorMessage } from "../runtime/recall-service-helpers.js";

export interface RoutingKeySupplement {
  readonly keysByOwnerIdentity: ReadonlyMap<
    string,
    readonly Readonly<SelectedSliceKeyV2>[]
  >;
  readonly queryKeys: readonly Readonly<SelectedSliceKeyV2>[];
  readonly activationByOwnerIdentity: ReadonlyMap<
    string,
    Readonly<AttributedKeyActivationV1>
  >;
}

interface CollectRoutingKeySupplementParams {
  readonly dependencies: Pick<
    RecallServiceDependencies,
    "routingKeyProjectionPort" | "entityExtractionPort"
  >;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly ownerIds: readonly string[];
  readonly asOfMs: number;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
}

export async function collectRoutingKeySupplement(
  params: CollectRoutingKeySupplementParams
): Promise<Readonly<RoutingKeySupplement>> {
  const [projections, queryEntities] = await Promise.all([
    loadProjections(params),
    extractQueryEntities(params)
  ]);
  const queryKeys = deriveQuerySliceKeysV2({
    workspaceId: params.workspaceId,
    queryProbes: params.queryProbes,
    queryEntities,
    asOfMs: params.asOfMs,
    nowIso: new Date(params.asOfMs).toISOString()
  });
  const keysByOwnerIdentity = groupProjectedRoutingKeys(
    projections,
    params.workspaceId,
    params.asOfMs
  );
  return Object.freeze({
    keysByOwnerIdentity,
    queryKeys,
    activationByOwnerIdentity: new Map([...keysByOwnerIdentity.entries()].map(
      ([identity, keys]) => [identity, computeAttributedKeyActivationV1(queryKeys, keys)]
    ))
  });
}

async function loadProjections(
  params: CollectRoutingKeySupplementParams
): Promise<readonly Readonly<RecallRoutingKeyProjection>[]> {
  const port = params.dependencies.routingKeyProjectionPort;
  if (port === undefined || params.ownerIds.length === 0) return Object.freeze([]);
  try {
    return await port.findByOwnerIds(params.workspaceId, params.ownerIds);
  } catch (error) {
    warn(params, "routing key projection lookup failed", "routing_key_projection_lookup", error);
    return Object.freeze([]);
  }
}

async function extractQueryEntities(
  params: CollectRoutingKeySupplementParams
): Promise<readonly Readonly<{ readonly normalized: string; readonly confidence: number }>[]> {
  const extractor = params.dependencies.entityExtractionPort;
  if (extractor === undefined || params.queryText === null) return Object.freeze([]);
  try {
    return await extractor.extract(params.queryText, { maxEntities: 24 });
  } catch (error) {
    warn(params, "routing query entity extraction failed", "routing_query_entity_extraction", error);
    return Object.freeze([]);
  }
}

function groupProjectedRoutingKeys(
  projections: readonly Readonly<RecallRoutingKeyProjection>[],
  workspaceId: string,
  asOfMs: number
): ReadonlyMap<string, readonly Readonly<SelectedSliceKeyV2>[]> {
  const grouped = new Map<string, Map<string, SelectedSliceKeyV2>>();
  for (const projection of projections) {
    const identity = projectedRoutingKeyOwnerIdentity(
      projection.owner_kind,
      projection.owner_id
    );
    const keys = deriveProjectedRoutingKeysV2({ workspaceId, projection, asOfMs });
    const byKey = grouped.get(identity) ?? new Map<string, SelectedSliceKeyV2>();
    for (const key of keys) byKey.set(key.key_id, key);
    grouped.set(identity, byKey);
  }
  return new Map([...grouped.entries()].map(([identity, byKey]) => [
    identity,
    Object.freeze([...byKey.values()].sort((left, right) =>
      left.key_id < right.key_id ? -1 : left.key_id > right.key_id ? 1 : 0
    ))
  ]));
}

function warn(
  params: CollectRoutingKeySupplementParams,
  message: string,
  operation: string,
  error: unknown
): void {
  params.warn(message, {
    workspace_id: params.workspaceId,
    operation,
    errorName: errorNameOf(error),
    error: toErrorMessage(error)
  });
}
