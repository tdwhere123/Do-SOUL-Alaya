import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SAMPLE_ROWS,
  deferred,
  jsonResponse,
  renderMemoryBrowser,
  urlOf,
  type FetchInput
} from "./memory-browser.test-support";
import { setInspectorToken, setWorkspaceId } from "../../api";

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


  it("refetches scope/conflict filters from the server instead of filtering only retained rows", async () => {
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("scope_class=global_core") && url.includes("has_conflict=true")) {
        return jsonResponse(
          {
            success: true,
            data: [
              {
                ...SAMPLE_ROWS[0]!,
                object_id: "mem-global-conflict",
                content: "global core conflicting memory",
                scope_class: "global_core",
                contradiction_count: 1
              }
            ]
          },
          200,
          {
            "x-total-count": "1",
            "x-limit": "200",
            "x-offset": "0"
          }
        );
      }
      if (url.includes("scope_class=global_core")) {
        return jsonResponse(
          {
            success: true,
            data: [
              {
                ...SAMPLE_ROWS[0]!,
                object_id: "mem-global-clear",
                content: "global core memory",
                scope_class: "global_core",
                contradiction_count: 0
              }
            ]
          },
          200,
          {
            "x-total-count": "1",
            "x-limit": "200",
            "x-offset": "0"
          }
        );
      }
      if (url.includes("/memory-entries/ws1")) {
        return jsonResponse(
          {
            success: true,
            data: [
              {
                ...SAMPLE_ROWS[0]!,
                object_id: "mem-project-only",
                content: "project memory"
              }
            ]
          },
          200,
          {
            "x-total-count": "1",
            "x-limit": "200",
            "x-offset": "0"
          }
        );
      }
      return jsonResponse({}, 404);
    });

    renderMemoryBrowser();

    expect(await screen.findByText("project memory")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "global_core" }));
    fireEvent.click(screen.getByRole("button", { name: "has_conflict" }));

    expect(await screen.findByText("global core conflicting memory")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/memory-entries/ws1?scope_class=global_core&has_conflict=true&limit=200&offset=0"
      ),
      expect.any(Object)
    );
  });


  it("drops stale load-more results after a refresh starts a new pagination generation", async () => {
    const loadMoreDeferred = deferred<Response>();
    const refreshDeferred = deferred<Response>();
    let offsetZeroCalls = 0;
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/memory-entries/ws1") && url.includes("offset=1")) {
        return await loadMoreDeferred.promise;
      }
      if (url.includes("/memory-entries/ws1") && url.includes("offset=0")) {
        offsetZeroCalls += 1;
        if (offsetZeroCalls === 1) {
          return jsonResponse(
            {
              success: true,
              data: [
                {
                  ...SAMPLE_ROWS[0]!,
                  object_id: "mem-initial",
                  content: "initial page row"
                }
              ]
            },
            200,
            {
              "x-total-count": "2",
              "x-limit": "200",
              "x-offset": "0"
            }
          );
        }
        return await refreshDeferred.promise;
      }
      return jsonResponse({}, 404);
    });

    renderMemoryBrowser();

    expect(await screen.findByText("initial page row")).not.toBeNull();
    fireEvent.click(screen.getByTestId("memory-load-more"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    refreshDeferred.resolve(
      jsonResponse(
        {
          success: true,
          data: [
            {
              ...SAMPLE_ROWS[0]!,
              object_id: "mem-refresh",
              content: "refreshed page row"
            }
          ]
        },
        200,
        {
          "x-total-count": "1",
          "x-limit": "200",
          "x-offset": "0"
        }
      )
    );
    expect(await screen.findByText("refreshed page row")).not.toBeNull();

    loadMoreDeferred.resolve(
      jsonResponse(
        {
          success: true,
          data: [
            {
              ...SAMPLE_ROWS[0]!,
              object_id: "mem-stale-load-more",
              content: "stale load more row"
            }
          ]
        },
        200,
        {
          "x-total-count": "2",
          "x-limit": "200",
          "x-offset": "1"
        }
      )
    );

    await waitFor(() => {
      expect(screen.queryByText("stale load more row")).toBeNull();
      expect(screen.getByTestId("memory-pagination-status").textContent).toContain("1 of 1 loaded");
    });
  });


  it("closes the evidence panel when a refresh removes the selected row from the first page", async () => {
    let offsetZeroCalls = 0;
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (!url.includes("/memory-entries/ws1") || !url.includes("offset=0")) {
        return jsonResponse({}, 404);
      }
      offsetZeroCalls += 1;
      if (offsetZeroCalls === 1) {
        return jsonResponse(
          {
            success: true,
            data: [
              {
                ...SAMPLE_ROWS[0]!,
                object_id: "mem-selected",
                content: "selected memory row"
              }
            ]
          },
          200,
          {
            "x-total-count": "1",
            "x-limit": "200",
            "x-offset": "0"
          }
        );
      }
      return jsonResponse(
        {
          success: true,
          data: [
            {
              ...SAMPLE_ROWS[0]!,
              object_id: "mem-replacement",
              content: "replacement memory row"
            }
          ]
        },
        200,
        {
          "x-total-count": "1",
          "x-limit": "200",
          "x-offset": "0"
        }
      );
    });

    renderMemoryBrowser();

    fireEvent.click(await screen.findByText("selected memory row"));
    expect(await screen.findByText("Evidence")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("replacement memory row")).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("Evidence")).toBeNull();
    });
  });

});
