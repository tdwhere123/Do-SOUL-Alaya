import { describe, expect, it, vi } from "vitest";
import {
  buildAnchorScopedFtsMatch,
  buildFtsMatchExpression,
  buildWorkspaceFtsScopeMatch,
  buildWorkspaceScopedFtsMatch,
  queryFtsLaneRows
} from "../../../repos/shared/fts-lane-routing.js";

describe("buildFtsMatchExpression", () => {
  it("ORs quoted tokens and escapes embedded quotes", () => {
    expect(buildFtsMatchExpression(["alpha", "beta"])).toBe('"alpha" OR "beta"');
    expect(buildFtsMatchExpression(['a"b'])).toBe('"a""b"');
  });
});

describe("buildWorkspaceScopedFtsMatch", () => {
  it("scopes content terms to one indexed workspace column", () => {
    expect(buildWorkspaceScopedFtsMatch("workspace-1", ["alpha", "beta"])).toBe(
      'workspace_id:"workspace-1" AND content:("alpha" OR "beta")'
    );
    expect(buildWorkspaceFtsScopeMatch("workspace-1")).toBe('workspace_id:"workspace-1"');
    expect(buildWorkspaceScopedFtsMatch('workspace-"quoted"', ["alpha"])).toBe(
      'workspace_id:"workspace-""quoted""" AND content:("alpha")'
    );
  });
});

describe("buildAnchorScopedFtsMatch", () => {
  it("requires the anchor and keeps all terms for BM25 ranking", () => {
    expect(buildAnchorScopedFtsMatch("ws", ["alpha"], ["beta"])).toBe(
      'workspace_id:"ws" AND content:(("alpha") AND ("alpha" OR "beta"))'
    );
  });

  it("collapses to just the anchor clause when there is no optional term", () => {
    expect(buildAnchorScopedFtsMatch("ws", ["alpha"], [])).toBe(
      'workspace_id:"ws" AND content:(("alpha"))'
    );
  });

  it("returns null when there is no anchor (caller falls back to relaxed)", () => {
    expect(buildAnchorScopedFtsMatch("ws", [], ["beta"])).toBeNull();
    expect(buildAnchorScopedFtsMatch("ws", ["  "], ["beta"])).toBeNull();
  });

  it("dedupes an optional term that repeats an anchor", () => {
    expect(buildAnchorScopedFtsMatch("ws", ["alpha"], ["alpha"])).toBe(
      'workspace_id:"ws" AND content:(("alpha"))'
    );
  });
});

describe("queryFtsLaneRows", () => {
  it("executes a workspace-scoped MATCH and returns raw lane rows", () => {
    const statement = {
      all: vi.fn(() => [
        { object_id: "first", raw_rank: -10 },
        { object_id: "second", raw_rank: -5 }
      ])
    };

    const result = queryFtsLaneRows(statement, "workspace-1", ["alpha"], 2);

    expect(statement.all).toHaveBeenCalledWith(
      "workspace-1",
      'workspace_id:"workspace-1" AND content:("alpha")',
      2
    );
    expect(result).toEqual([
      { object_id: "first", raw_rank: -10 },
      { object_id: "second", raw_rank: -5 }
    ]);
  });
});
