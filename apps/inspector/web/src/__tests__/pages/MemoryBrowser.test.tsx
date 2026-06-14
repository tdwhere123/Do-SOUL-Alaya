import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MemoryBrowserPage from "../../pages/MemoryBrowser";
import { ToastProvider } from "../../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../../api";

function renderMemoryBrowser() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <MemoryBrowserPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

const SAMPLE_ROWS = [
  {
    object_id: "mem-abc-1234567890",
    object_kind: "memory_entry",
    content: "remember preference",
    dimension: "preference",
    scope_class: "project",
    domain_tags: ["tag-1"],
    evidence_refs: [],
    created_at: "2026-05-10T00:00:00.000Z",
    contradiction_count: 0,
    source_kind: "user_assert",
    storage_tier: "warm",
    activation_score: 0.4
  }
];

describe("MemoryBrowserPage promote-to-strictly_governed", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setInspectorToken("t");
    setWorkspaceId("ws1");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null);
  });

  it("POSTs a typed path_relation Proposal when the promote button is clicked", async () => {
    fetchMock.mockImplementation(async (input: FetchInput, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/memory-entries/ws1")) {
        return jsonResponse({ success: true, data: SAMPLE_ROWS }, 200, {
          "x-total-count": "1",
          "x-limit": "200",
          "x-offset": "0"
        });
      }
      if (url.includes("/proposals/promote-strictly-governed") && init?.method === "POST") {
        return jsonResponse({
          success: true,
          data: {
            proposal_id: "promo-1",
            status: "created",
            target_object_id: "mem-abc-1234567890",
            target_object_kind: "path_relation",
            requested_governance_class: "strictly_governed"
          }
        });
      }
      return jsonResponse({}, 404);
    });

    renderMemoryBrowser();

    const row = await screen.findByText(/remember preference/);
    fireEvent.click(row);

    const button = await screen.findByTestId("promote-strictly-governed");
    fireEvent.click(button);

    await waitFor(() => {
      const matched = fetchMock.mock.calls.some((call) => {
        const url = urlOf(call[0] as FetchInput);
        const init = call[1] as RequestInit | undefined;
        return (
          url.includes("/workspaces/ws1/soul/memory/") &&
          url.includes("/proposals/promote-strictly-governed") &&
          init?.method === "POST"
        );
      });
      expect(matched).toBe(true);
    });
  });

  it("loads additional memory pages instead of silently truncating at the first page", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      ...SAMPLE_ROWS[0]!,
      object_id: `mem-${String(index).padStart(3, "0")}`,
      content: `memory page one ${index}`
    }));
    const secondPage = [
      {
        ...SAMPLE_ROWS[0]!,
        object_id: "mem-200",
        content: "memory page two 200"
      }
    ];
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/memory-entries/ws1") && url.includes("offset=0")) {
        return jsonResponse({ success: true, data: firstPage }, 200, {
          "x-total-count": "201",
          "x-limit": "200",
          "x-offset": "0"
        });
      }
      if (url.includes("/memory-entries/ws1") && url.includes("offset=200")) {
        return jsonResponse({ success: true, data: secondPage }, 200, {
          "x-total-count": "201",
          "x-limit": "200",
          "x-offset": "200"
        });
      }
      return jsonResponse({}, 404);
    });

    renderMemoryBrowser();

    expect((await screen.findByTestId("memory-pagination-status")).textContent).toContain(
      "200 of 201 loaded"
    );
    fireEvent.click(screen.getByTestId("memory-load-more"));

    expect(await screen.findByText("memory page two 200")).not.toBeNull();
    expect(screen.getByTestId("memory-pagination-status").textContent).toContain(
      "201 of 201 loaded"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/memory-entries/ws1?limit=200&offset=200"),
      expect.any(Object)
    );
  });
});
