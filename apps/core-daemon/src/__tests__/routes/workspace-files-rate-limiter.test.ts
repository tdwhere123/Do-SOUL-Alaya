import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceGitRateLimiter } from "../../routes/workspace/workspace-files.js";

describe("createWorkspaceGitRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops stale workspace entries during periodic cleanup", () => {
    vi.useFakeTimers();
    const limiter = createWorkspaceGitRateLimiter(1, 1_000);

    expect(limiter.allow("ws-stale")).toBe(true);
    expect(limiter.allow("ws-stale")).toBe(false);

    vi.advanceTimersByTime(1_100);

    for (let index = 0; index < 128; index += 1) {
      limiter.allow("ws-trigger");
    }

    expect(limiter.allow("ws-stale")).toBe(true);
  });

  it("keeps active workspaces rate-limited within the window", () => {
    const limiter = createWorkspaceGitRateLimiter(2, 60_000);

    expect(limiter.allow("ws-1")).toBe(true);
    expect(limiter.allow("ws-1")).toBe(true);
    expect(limiter.allow("ws-1")).toBe(false);
  });
});
