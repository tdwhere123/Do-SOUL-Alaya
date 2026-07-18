import { createHash } from "node:crypto";
import type {
  RelationAssertion,
  RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../shared/stable-stringify.js";
import {
  buildTemporalPathProjection,
  TEMPORAL_RELATION_PROJECTION_POLICY_ID,
  TEMPORAL_RELATION_PROJECTION_POLICY_SHA256
} from "./relation-projection-policy.js";
import type { RelationAssertionProjectionResult } from "./relation-assertion-service-types.js";

const ASSERTION_SCHEMA_GENERATION = "relation_assertion_v1";
const ASSERTION_EVENT_CONTRACT_GENERATION = "relation_assertion_event_v1";
const PROJECTION_SCHEMA_GENERATION = "relation_path_projection_v1";

export function buildRelationProjection(
  assertions: readonly Readonly<RelationAssertion>[],
  resolutions: readonly Readonly<RelationAssertionResolution>[],
  asOf: string,
  permittedTimelessPolicyIds: ReadonlySet<string>
): RelationAssertionProjectionResult {
  const projections = buildActiveRelationProjections(
    assertions,
    resolutions,
    asOf,
    permittedTimelessPolicyIds
  );
  const historyDigest = buildRelationHistoryDigest(assertions, resolutions);
  const projectionDigest = sha256RelationAssertionValue(stableStringify(projections));
  return {
    activeProjectionCount: projections.length,
    nextProjectionRefreshAt: findNextProjectionRefreshAt(assertions, resolutions, asOf),
    generation: {
      generation: `temporal-${sha256RelationAssertionValue(`${historyDigest}|${asOf}`).slice(0, 48)}`,
      assertionSchemaGeneration: ASSERTION_SCHEMA_GENERATION,
      assertionEventContractGeneration: ASSERTION_EVENT_CONTRACT_GENERATION,
      projectionSchemaGeneration: PROJECTION_SCHEMA_GENERATION,
      projectionPolicyId: TEMPORAL_RELATION_PROJECTION_POLICY_ID,
      projectionPolicySha256: TEMPORAL_RELATION_PROJECTION_POLICY_SHA256,
      historyDigest,
      asOf,
      projectionDigest,
      projections,
      createdAt: asOf
    }
  };
}

function buildActiveRelationProjections(
  assertions: readonly Readonly<RelationAssertion>[],
  resolutions: readonly Readonly<RelationAssertionResolution>[],
  asOf: string,
  permittedTimelessPolicyIds: ReadonlySet<string>
): RelationAssertionProjectionResult["generation"]["projections"] {
  const resolutionsByAssertion = groupResolutionsByAssertion(resolutions);
  return assertions.flatMap((assertion) => {
    const projection = buildTemporalPathProjection({
      assertion,
      resolutions: resolutionsByAssertion.get(assertion.assertion_id) ?? [],
      asOf,
      permittedTimelessPolicyIds
    });
    return projection === null ? [] : [projection];
  }).sort((left, right) => left.path_id.localeCompare(right.path_id));
}

function groupResolutionsByAssertion(
  resolutions: readonly Readonly<RelationAssertionResolution>[]
): ReadonlyMap<string, readonly Readonly<RelationAssertionResolution>[]> {
  const grouped = new Map<string, RelationAssertionResolution[]>();
  for (const resolution of resolutions) {
    const current = grouped.get(resolution.assertion_id) ?? [];
    current.push(resolution);
    grouped.set(resolution.assertion_id, current);
  }
  return grouped;
}

function buildRelationHistoryDigest(
  assertions: readonly Readonly<RelationAssertion>[],
  resolutions: readonly Readonly<RelationAssertionResolution>[]
): string {
  return sha256RelationAssertionValue(stableStringify({
    assertions: assertions.map((assertion) => ({
      assertion_id: assertion.assertion_id,
      admission_event_id: assertion.admission_event_id,
      workspace_id: assertion.workspace_id,
      evidence_ids: assertion.evidence_ids,
      anchors: assertion.anchors,
      relation_kind: assertion.relation_kind,
      validity: assertion.validity,
      admitted_at: assertion.admitted_at
    })),
    resolutions: resolutions.map((resolution) => ({
      resolution_id: resolution.resolution_id,
      event_id: resolution.event_id,
      assertion_id: resolution.assertion_id,
      workspace_id: resolution.workspace_id,
      resolution_kind: resolution.resolution_kind,
      resolved_at: resolution.resolved_at,
      reason: resolution.reason
    }))
  }));
}

function findNextProjectionRefreshAt(
  assertions: readonly Readonly<RelationAssertion>[],
  resolutions: readonly Readonly<RelationAssertionResolution>[],
  asOf: string
): string | null {
  const asOfMs = Date.parse(asOf);
  let nextMs = Number.POSITIVE_INFINITY;
  const consider = (timestamp: string): void => {
    const timestampMs = Date.parse(timestamp);
    if (timestampMs > asOfMs && timestampMs < nextMs) nextMs = timestampMs;
  };
  for (const assertion of assertions) {
    if (assertion.validity.kind === "open") consider(assertion.validity.valid_from);
    if (assertion.validity.kind === "bounded") {
      consider(assertion.validity.valid_from);
      consider(assertion.validity.valid_to);
    }
  }
  for (const resolution of resolutions) consider(resolution.resolved_at);
  return Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : null;
}

export function sha256RelationAssertionValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
