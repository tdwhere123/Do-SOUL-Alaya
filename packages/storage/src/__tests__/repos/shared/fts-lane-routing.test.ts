import type BetterSqlite3 from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  buildFtsMatchExpression,
  buildWorkspaceScopedFtsMatch,
  queryFtsLane
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
    expect(buildWorkspaceScopedFtsMatch('workspace-"quoted"', ["alpha"])).toBe(
      'workspace_id:"workspace-""quoted""" AND content:("alpha")'
    );
  });
});

describe("queryFtsLane", () => {
  it("executes a workspace-scoped MATCH and returns ranked lane rows", () => {
    const statement = {
      all: vi.fn(() => [
        { object_id: "first", raw_rank: -10 },
        { object_id: "second", raw_rank: -5 }
      ])
    } as unknown as BetterSqlite3.Statement;

    const result = queryFtsLane(statement, "workspace-1", ["alpha"], 2);

    expect(statement.all).toHaveBeenCalledWith(
      "workspace-1",
      'workspace_id:"workspace-1" AND content:("alpha")',
      2
    );
    expect(result).toEqual([
      { object_id: "first", normalized_rank: 1 },
      { object_id: "second", normalized_rank: 0.5 }
    ]);
  });
});
