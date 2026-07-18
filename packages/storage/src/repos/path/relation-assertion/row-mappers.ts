import {
  RelationAssertionResolutionSchema,
  RelationAssertionSchema,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import {
  parseRelationAssertionJson,
  parseRelationAssertionJsonArray
} from "../relation-assertion-repo-support.js";

export type AssertionRow = Readonly<{
  readonly assertion_id: string;
  readonly workspace_id: string;
  readonly admission_event_id: string;
  readonly anchors_json: string;
  readonly relation_kind: string;
  readonly validity_json: string;
  readonly admitted_at: string;
  readonly evidence_ids_json: string;
}>;

export type ResolutionRow = Readonly<{
  readonly resolution_id: string;
  readonly assertion_id: string;
  readonly workspace_id: string;
  readonly resolution_event_id: string;
  readonly resolution_kind: string;
  readonly resolved_at: string;
  readonly reason: string;
}>;

export function parseAssertionRow(row: AssertionRow): Readonly<RelationAssertion> {
  return RelationAssertionSchema.parse({
    assertion_id: row.assertion_id,
    workspace_id: row.workspace_id,
    admission_event_id: row.admission_event_id,
    evidence_ids: parseRelationAssertionJsonArray(
      row.evidence_ids_json,
      "relation assertion evidence"
    ),
    anchors: parseRelationAssertionJson(row.anchors_json, "relation assertion anchors"),
    relation_kind: row.relation_kind,
    validity: parseRelationAssertionJson(row.validity_json, "relation assertion validity"),
    admitted_at: row.admitted_at
  });
}

export function parseResolutionRow(
  row: ResolutionRow
): Readonly<RelationAssertionResolution> {
  return RelationAssertionResolutionSchema.parse({
    resolution_id: row.resolution_id,
    assertion_id: row.assertion_id,
    workspace_id: row.workspace_id,
    event_id: row.resolution_event_id,
    resolution_kind: row.resolution_kind,
    resolved_at: row.resolved_at,
    reason: row.reason
  });
}
