import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGetWorkspaceById } from "../../cli/inspect-daemon-client.js";

// invariant: a 200 response whose body is not valid JSON is a broken daemon,
// not an empty-ok workspace. defaultGetWorkspaceById must surface
// { status: "error", detail: "non-JSON response" } so the CLI can distinguish
// empty vs broken.
// see also: apps/core-daemon/src/cli/inspect-daemon-client.ts

describe("defaultGetWorkspaceById on a 200 with malformed JSON", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a non-JSON error rather than an empty-ok workspace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    );

    const result = await defaultGetWorkspaceById("http://127.0.0.1:8787", "ws-1");

    expect(result).toEqual({ status: "error", detail: "non-JSON response" });
  });

  it("still returns ok with the parsed workspace on valid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { workspace_id: "ws-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await defaultGetWorkspaceById("http://127.0.0.1:8787", "ws-1");

    expect(result.status).toBe("ok");
    expect(result.status === "ok" ? result.workspace.workspace_id : null).toBe("ws-1");
  });
});
