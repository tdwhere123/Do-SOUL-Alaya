import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_GIT_LOG_LIMIT,
  MAX_WORKSPACE_GIT_LOG_LIMIT,
  parseWorkspaceGitLogLimit
} from "../../workspace/workspace-files.js";

describe("workspace file protocol helpers", () => {
  it("parses git log query bounds from the shared protocol contract", () => {
    expect(parseWorkspaceGitLogLimit(undefined)).toBe(DEFAULT_WORKSPACE_GIT_LOG_LIMIT);
    expect(parseWorkspaceGitLogLimit(String(MAX_WORKSPACE_GIT_LOG_LIMIT))).toBe(
      MAX_WORKSPACE_GIT_LOG_LIMIT
    );
    expect(parseWorkspaceGitLogLimit(25)).toBe(25);
    expect(() => parseWorkspaceGitLogLimit(101)).toThrow(
      "limit must be an integer between 1 and 100"
    );
    expect(() => parseWorkspaceGitLogLimit("10foo")).toThrow(
      "limit must be an integer between 1 and 100"
    );
  });
});
