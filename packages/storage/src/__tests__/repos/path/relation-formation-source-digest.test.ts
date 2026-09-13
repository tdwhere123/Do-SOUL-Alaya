import { describe, expect, it } from "vitest";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { digestRelationFormationEventSource } from "../../../repos/path/relation-assertion/source-digest.js";

describe("relation formation source digest", () => {
  it("canonicalizes mixed-case keys with the protocol authority", () => {
    expect(canonicalJson({ a: 1, B: 2, "": 0 })).toBe('{"":0,"B":2,"a":1}');
    const left = digestRelationFormationEventSource(event({ payload_json: { a: 1, B: 2 } }));
    const right = digestRelationFormationEventSource(event({ payload_json: { B: 2, a: 1 } }));
    expect(left).toBe(right);
  });
});

function event(overrides: { readonly payload_json: unknown }) {
  return {
    event_id: "event-1",
    event_type: "soul.memory.created",
    entity_type: "memory_entry",
    entity_id: "object-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    caused_by: "user_action",
    revision: 1,
    payload_json: overrides.payload_json,
    created_at: "2026-09-13T00:00:00.000Z"
  };
}
