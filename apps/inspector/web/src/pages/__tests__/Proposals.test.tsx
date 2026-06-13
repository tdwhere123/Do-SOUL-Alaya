import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import ProposalsPage from "../Proposals";
import { setInspectorToken, setWorkspaceId } from "../../api";
import { ToastProvider } from "../../components/Toast";

interface PendingProposalFixture {
  readonly proposal_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly created_at: string;
  readonly proposed_change_summary: string;
  readonly proposed_changes: Record<string, unknown> | null;
}

describe("ProposalsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    fetchMock = vi.fn().mockResolvedValue(pendingResponse([pendingProposal()]));
    vi.stubGlobal("fetch", fetchMock);
    scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("highlights the proposal id passed from Inspector memory actions", async () => {
    renderProposals("/proposals?highlight=proposal-1");

    await screen.findByText("proposal-1");
    const row = screen.getByText("proposal-1").closest("li");

    await waitFor(() => {
      expect(row?.className).toContain("border-2");
      expect(row?.className).toContain("border-state-emphasis");
      expect(row?.getAttribute("aria-current")).toBe("true");
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
    expect(document.activeElement).toBe(row);
  });

  it("renders exact proposed_changes before accept", async () => {
    renderProposals();

    await screen.findByText("proposal-1");

    expect(screen.getByText("Proposed changes")).toBeTruthy();
    expect(screen.getByText(/\"content\": \"Use rtk for every repo command.\"/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", false);
  });

  it("disables accept when proposed_changes is unavailable", async () => {
    fetchMock.mockResolvedValueOnce(pendingResponse([{ ...pendingProposal(), proposed_changes: null }]));

    renderProposals();

    await screen.findByText("Proposed changes payload unavailable. Accept is disabled.");
    expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty("disabled", false);
  });

  it("submits reviewer identity and review reason through the workspace-scoped route", async () => {
    fetchMock
      .mockResolvedValueOnce(pendingResponse([pendingProposal()]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { proposal_id: "proposal-1", resolution_state: "accepted" }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(pendingResponse([]));

    renderProposals();

    await userEvent.type(await screen.findByLabelText(/reviewer identity/i), "user:reviewer");
    await userEvent.type(
      screen.getByLabelText("Review reason for proposal proposal-1"),
      "looks correct"
    );
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/proposals/ws-1/proposal-1/review",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            verdict: "accept",
            reason: "looks correct",
            reviewer_identity: "user:reviewer"
          })
        })
      );
    });
  });

  it("handles unauthorized refresh without an unhandled rejection", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    renderProposals();

    await screen.findByText("No pending proposals.");
    expect(screen.queryByText(/Error:/)).toBeNull();
  });
});

function renderProposals(path = "/proposals") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <ProposalsPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function pendingProposal(): PendingProposalFixture {
  return {
    proposal_id: "proposal-1",
    target_object_id: "memory-1",
    target_object_kind: "memory_entry",
    created_at: "2026-05-05T00:00:00.000Z",
    proposed_change_summary: "Rewrite memory",
    proposed_changes: { content: "Use rtk for every repo command." }
  };
}

function pendingResponse(proposals: readonly PendingProposalFixture[]) {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        proposals,
        total_count: proposals.length
      }
    }),
    { status: 200 }
  );
}
