import { describe, expect, it } from "vitest";
import {
  applyRemoteBindTokenRotation,
  authorizeProtectedRequest,
  type RequestTokenProtection
} from "../../runtime/request-token-binding.js";

const PROCESS_TOKEN = "process-token";
const WORKSPACE_A_TOKEN = "workspace-a-token";
const WORKSPACE_B_TOKEN = "workspace-b-token";

const protection = {
  requestToken: PROCESS_TOKEN,
  boundWorkspaceIds: ["ws-default"] as const,
  allowProcessSecretPatch: true,
  workspaceTokens: [
    { token: WORKSPACE_A_TOKEN, workspaceIds: ["ws-a"] },
    { token: WORKSPACE_B_TOKEN, workspaceIds: ["ws-b"] }
  ]
};

describe("request token workspace binding", () => {
  it("rejects a workspace A token against workspace B paths", () => {
    const allowed = authorizeProtectedRequest({
      providedToken: WORKSPACE_A_TOKEN,
      protection,
      method: "GET",
      path: "/workspaces/ws-a/memories"
    });
    const forbidden = authorizeProtectedRequest({
      providedToken: WORKSPACE_A_TOKEN,
      protection,
      method: "GET",
      path: "/workspaces/ws-b/memories"
    });

    expect(allowed).toEqual({
      ok: true,
      grant: {
        token: WORKSPACE_A_TOKEN,
        workspaceIds: ["ws-a"],
        allowProcessSecretPatch: false
      }
    });
    expect(forbidden).toEqual({
      ok: false,
      error: "Workspace is not authorized for this token"
    });
  });

  it("rejects an Inspector workspace token from PATCHing process-level secrets", () => {
    const inspectorPatch = authorizeProtectedRequest({
      providedToken: WORKSPACE_A_TOKEN,
      protection,
      method: "PATCH",
      path: "/config/runtime/embedding-supplement"
    });
    const processPatch = authorizeProtectedRequest({
      providedToken: PROCESS_TOKEN,
      protection,
      method: "PATCH",
      path: "/config/runtime/embedding-supplement"
    });

    expect(inspectorPatch).toEqual({
      ok: false,
      error: "Process-level secret patch is not allowed"
    });
    expect(processPatch.ok).toBe(true);
  });

  it("does not let the default-workspace process token hit an arbitrary workspace id", () => {
    const allowed = authorizeProtectedRequest({
      providedToken: PROCESS_TOKEN,
      protection,
      method: "GET",
      path: "/workspaces/ws-default/memories"
    });
    const forbidden = authorizeProtectedRequest({
      providedToken: PROCESS_TOKEN,
      protection,
      method: "GET",
      path: "/workspaces/ws-a/memories"
    });

    expect(allowed.ok).toBe(true);
    expect(forbidden).toEqual({
      ok: false,
      error: "Workspace is not authorized for this token"
    });
  });

  it("rotates a long-lived file token when unix-socket bind is configured", () => {
    const rotated = applyRemoteBindTokenRotation(
      { requestToken: "file-token", tokenSource: "env" as const },
      { ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock" }
    );
    expect(rotated.tokenSource).toBe("rotated");
    expect(rotated.requestToken).not.toBe("file-token");
  });

  it("does not bind the process token to ALAYA_WORKSPACE_ID", () => {
    const bound = applyRemoteBindTokenRotation(
      { requestToken: PROCESS_TOKEN } as RequestTokenProtection,
      { ALAYA_WORKSPACE_ID: "ws-default" }
    );
    expect(bound.boundWorkspaceIds).toBeUndefined();
    const otherWorkspace = authorizeProtectedRequest({
      providedToken: PROCESS_TOKEN,
      protection: bound,
      method: "GET",
      path: "/workspaces/ws-other/memories"
    });
    expect(otherWorkspace.ok).toBe(true);
  });

  it("binds the process token only from ALAYA_REQUEST_TOKEN_WORKSPACES", () => {
    const bound = applyRemoteBindTokenRotation(
      { requestToken: PROCESS_TOKEN } as RequestTokenProtection,
      { ALAYA_WORKSPACE_ID: "ws-default", ALAYA_REQUEST_TOKEN_WORKSPACES: "ws-listed" }
    );
    expect(bound.boundWorkspaceIds).toEqual(["ws-listed"]);
    const listed = authorizeProtectedRequest({
      providedToken: PROCESS_TOKEN,
      protection: bound,
      method: "GET",
      path: "/workspaces/ws-listed/memories"
    });
    const other = authorizeProtectedRequest({
      providedToken: PROCESS_TOKEN,
      protection: bound,
      method: "GET",
      path: "/workspaces/ws-default/memories"
    });
    expect(listed.ok).toBe(true);
    expect(other.ok).toBe(false);
  });
});
