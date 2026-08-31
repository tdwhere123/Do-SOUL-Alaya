import type { PathAnchorRef } from "./path-relation.js";

export function serializePathAnchorRef(anchor: PathAnchorRef): string {
  switch (anchor.kind) {
    case "object":
      return JSON.stringify(["object", anchor.object_id]);
    case "object_facet":
      return JSON.stringify(["object_facet", anchor.object_id, anchor.facet_key]);
    case "obligation":
      return JSON.stringify(["obligation", anchor.source_object_id, anchor.obligation_digest]);
    case "risk_concern":
      return JSON.stringify(["risk_concern", anchor.source_object_id, anchor.concern_digest]);
    case "time_concern":
      return JSON.stringify(["time_concern", anchor.source_object_id, anchor.window_digest]);
  }
}

export function listPathAnchorRefContextRefs(anchor: PathAnchorRef): readonly string[] {
  const serialized = serializePathAnchorRef(anchor);

  switch (anchor.kind) {
    case "object":
      return Object.freeze([serialized, anchor.object_id, `object:${anchor.object_id}`]);
    case "object_facet":
      return Object.freeze([
        serialized,
        anchor.object_id,
        `object:${anchor.object_id}`,
        `${anchor.object_id}:${anchor.facet_key}`,
        `object_facet:${anchor.object_id}:${anchor.facet_key}`
      ]);
    case "obligation":
      return Object.freeze([
        serialized,
        anchor.source_object_id,
        anchor.obligation_digest,
        `${anchor.source_object_id}:${anchor.obligation_digest}`,
        `obligation:${anchor.source_object_id}:${anchor.obligation_digest}`
      ]);
    case "risk_concern":
      return Object.freeze([
        serialized,
        anchor.source_object_id,
        anchor.concern_digest,
        `${anchor.source_object_id}:${anchor.concern_digest}`,
        `risk_concern:${anchor.source_object_id}:${anchor.concern_digest}`
      ]);
    case "time_concern":
      return Object.freeze([
        serialized,
        anchor.source_object_id,
        anchor.window_digest,
        `${anchor.source_object_id}:${anchor.window_digest}`,
        `time_concern:${anchor.source_object_id}:${anchor.window_digest}`
      ]);
  }
}
