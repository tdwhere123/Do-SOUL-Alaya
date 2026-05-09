import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProposalsPage from "./Proposals";
import { setInspectorToken, setWorkspaceId } from "../api";
import { ToastProvider } from "../components/Toast";

describe("ProposalsPage", () => {
  beforeEach(() => {
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              proposals: [
                {
                  proposal_id: "proposal-1",
                  target_object_id: "memory-1",
                  target_object_kind: "memory_entry",
                  created_at: "2026-05-05T00:00:00.000Z",
                  proposed_change_summary: "Rewrite memory"
                }
              ],
              total_count: 1
            }
          }),
          { status: 200 }
        )
      )
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("highlights the proposal id passed from Inspector memory actions", async () => {
    render(
      <MemoryRouter initialEntries={["/proposals?highlight=proposal-1"]}>
        <ToastProvider>
          <ProposalsPage />
        </ToastProvider>
      </MemoryRouter>
    );

    await screen.findByText("proposal-1");
    const row = screen.getByText("proposal-1").closest("li");

    await waitFor(() => {
      expect(row?.className).toContain("border-2");
      expect(row?.className).toContain("border-[#B58900]");
    });
  });
});

