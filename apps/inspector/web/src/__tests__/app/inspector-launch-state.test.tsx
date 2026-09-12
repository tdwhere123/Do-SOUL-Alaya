import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, setInspectorToken, setUnauthorizedHandler, setWorkspaceId } from "../../api/api";
import { useInspectorLaunchState } from "../../app/inspector-launch-state";

function LaunchProbe() {
  const state = useInspectorLaunchState();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="expired">{String(state.sessionExpired)}</div>
      <div data-testid="ready">{String(state.ready)}</div>
      <button type="button" onClick={() => navigate({ hash: "#workspaceId=ws1" })}>
        change-hash
      </button>
    </div>
  );
}

describe("useInspectorLaunchState", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setInspectorToken("test-token");
    setWorkspaceId("ws1");
    setUnauthorizedHandler(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    setWorkspaceId(null);
    setUnauthorizedHandler(null);
  });

  it("keeps the 401 handler across hash-only navigation", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <LaunchProbe />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));
    fireEvent.click(screen.getByText("change-hash"));
    await expect(apiFetch("/status")).rejects.toMatchObject({ status: 401 });
    await waitFor(() => expect(screen.getByTestId("expired").textContent).toBe("true"));
  });
});
